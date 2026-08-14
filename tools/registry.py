"""Central registry for all fan-agent tools.

Each tool file calls ``registry.register()`` at module level to declare its
schema, handler, toolset membership, and availability check.  ``model_tools.py``
queries the registry instead of maintaining its own parallel data structures.

Import chain (circular-import safe):
    tools/registry.py  (no imports from model_tools or tool files)
           ^
    tools/*.py  (import from tools.registry at module level)
           ^
    model_tools.py  (imports tools.registry + all tool modules)
           ^
    run_agent.py, cli.py, batch_runner.py, etc.
"""

import ast
import contextvars
import functools
import importlib
import json
import logging
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


def _is_tool_registration_call(node: ast.AST) -> bool:
    """Return True for a top-level built-in tool registration expression.

    Most tool modules register schemas directly with ``registry.register``.
    Larger toolsets may keep their schemas in a catalog and expose one
    ``register_*_tools`` bootstrap call from the public module instead.
    """
    if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
        return False
    func = node.value.func
    direct_registration = (
        isinstance(func, ast.Attribute)
        and func.attr == "register"
        and isinstance(func.value, ast.Name)
        and func.value.id == "registry"
    )
    catalog_registration = (
        isinstance(func, ast.Name)
        and func.id.startswith("register_")
        and func.id.endswith("_tools")
    )
    return direct_registration or catalog_registration


def _module_registers_tools(module_path: Path) -> bool:
    """Return True when the module contains a top-level registration call.

    Only inspects module-body statements so that helper modules which happen
    to call ``registry.register()`` inside a function are not picked up.
    """
    try:
        source = module_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(module_path))
    except (OSError, SyntaxError):
        return False

    return any(_is_tool_registration_call(stmt) for stmt in tree.body)


def discover_builtin_tools(tools_dir: Optional[Path] = None) -> List[str]:
    """Import built-in self-registering tool modules and return their module names."""
    tools_path = Path(tools_dir) if tools_dir is not None else Path(__file__).resolve().parent
    module_names = [
        f"tools.{path.stem}"
        for path in sorted(tools_path.glob("*.py"))
        if path.name not in {"__init__.py", "registry.py", "mcp_tool.py"}
        and _module_registers_tools(path)
    ]

    imported: List[str] = []
    for mod_name in module_names:
        try:
            importlib.import_module(mod_name)
            imported.append(mod_name)
        except Exception as e:
            logger.warning("Could not import tool module %s: %s", mod_name, e)
    return imported


class ToolEntry:
    """Metadata for a single registered tool."""

    __slots__ = (
        "name", "toolset", "schema", "handler", "check_fn",
        "requires_env", "is_async", "description", "emoji",
        "max_result_size_chars", "dynamic_schema_overrides",
    )

    def __init__(self, name, toolset, schema, handler, check_fn,
                 requires_env, is_async, description, emoji,
                 max_result_size_chars=None, dynamic_schema_overrides=None):
        self.name = name
        self.toolset = toolset
        self.schema = schema
        self.handler = handler
        self.check_fn = check_fn
        self.requires_env = requires_env
        self.is_async = is_async
        self.description = description
        self.emoji = emoji
        self.max_result_size_chars = max_result_size_chars
        # Optional zero-arg callable returning a dict of schema overrides
        # applied at get_definitions() time. Use for fields that depend on
        # runtime config (e.g. delegate_task's description must reflect the
        # user's current delegation.max_concurrent_children / max_spawn_depth
        # so the model isn't told the wrong limits). The callable is invoked
        # on every get_definitions() call; results are merged shallow on top
        # of the base schema before the {"type": "function", ...} wrap.
        self.dynamic_schema_overrides = dynamic_schema_overrides


# ---------------------------------------------------------------------------
# check_fn TTL cache
#
# check_fn callables like tools/terminal_tool.check_terminal_requirements
# probe external state (Docker daemon, Modal SDK install, playwright binary
# availability). For a long-lived CLI or gateway process, calling them on
# every get_definitions() is pure waste — external state changes on human
# timescales. Cache results for ~30 s so env-var flips via ``fan tools``
# or live credential file changes propagate within a turn or two without
# requiring any explicit invalidation.
# ---------------------------------------------------------------------------

_CHECK_FN_TTL_SECONDS = 30.0
# A short last-good window prevents a one-off probe timeout from removing an
# otherwise working toolset (notably terminal/file tools) mid-conversation.
_CHECK_FN_FAILURE_GRACE_SECONDS = 60.0
_check_fn_cache: Dict[Callable, tuple[float, bool]] = {}
_check_fn_last_good: Dict[Callable, float] = {}
_check_fn_cache_lock = threading.Lock()


def _check_fn_cached(fn: Callable) -> bool:
    """Return a TTL-cached availability verdict, tolerating brief probe flakes."""
    now = time.monotonic()
    with _check_fn_cache_lock:
        cached = _check_fn_cache.get(fn)
        if cached is not None:
            ts, value = cached
            if now - ts < _CHECK_FN_TTL_SECONDS:
                return value
    raised = False
    try:
        value = bool(fn())
    except Exception:
        value = False
        raised = True
    with _check_fn_cache_lock:
        if value:
            _check_fn_last_good[fn] = now
            _check_fn_cache[fn] = (now, True)
            return True

        last_good = _check_fn_last_good.get(fn)
        if (
            last_good is not None
            and now - last_good < _CHECK_FN_FAILURE_GRACE_SECONDS
        ):
            # Do not cache the transient failure: the next definition build
            # retries the probe instead of pinning a stale result.
            logger.warning(
                "Tool availability check %s %s within %.0fs of a success; "
                "keeping dependent tools available for this turn",
                getattr(fn, "__qualname__", fn),
                "raised" if raised else "returned False",
                _CHECK_FN_FAILURE_GRACE_SECONDS,
            )
            return True

        logger.warning(
            "Tool availability check %s %s; dependent tools are unavailable this turn",
            getattr(fn, "__qualname__", fn),
            "raised" if raised else "returned False",
        )
        _check_fn_cache[fn] = (now, False)
        return False



class ToolRegistry:
    """Singleton registry that collects tool schemas + handlers from tool files."""

    def __init__(self):
        self._tools: Dict[str, ToolEntry] = {}
        # Plugin tool replacement is a separate trust decision from enabling a
        # plugin.  Keep a durable namespace -> (allowed, plugin_id) policy so a
        # delayed callback cannot wait until plugin loading has finished and
        # then replace a privileged built-in tool.
        self._plugin_override_policy: Dict[str, tuple[bool, str]] = {}
        self._active_plugin_override = contextvars.ContextVar(
            f"fan_plugin_override_{id(self)}",
            default=None,
        )
        self._trusted_mcp_mutation = contextvars.ContextVar(
            f"fan_trusted_mcp_mutation_{id(self)}",
            default=0,
        )
        self._toolset_checks: Dict[str, Callable] = {}
        self._toolset_aliases: Dict[str, str] = {}
        # MCP dynamic refresh can mutate the registry while other threads are
        # reading tool metadata, so keep mutations serialized and readers on
        # stable snapshots.
        self._lock = threading.RLock()
        # Monotonically-increasing generation counter. Bumped on every
        # mutation (register / deregister / register_toolset_alias / MCP
        # refresh). External callers (e.g. get_tool_definitions) can memoize
        # against it: a cache entry keyed on the generation is valid for as
        # long as the generation hasn't changed.
        self._generation: int = 0

    def _snapshot_state(self) -> tuple[List[ToolEntry], Dict[str, Callable]]:
        """Return a coherent snapshot of registry entries and toolset checks."""
        with self._lock:
            return list(self._tools.values()), dict(self._toolset_checks)

    def _snapshot_entries(self) -> List[ToolEntry]:
        """Return a stable snapshot of registered tool entries."""
        return self._snapshot_state()[0]

    def _evaluate_toolset_check(self, toolset: str, check: Callable | None) -> bool:
        """Run a toolset check, treating missing or failing checks as unavailable/available."""
        if not check:
            return True
        try:
            return bool(check())
        except Exception:
            logger.debug("Toolset %s check raised; marking unavailable", toolset)
            return False

    def get_entry(self, name: str) -> Optional[ToolEntry]:
        """Return a registered tool entry by name, or None."""
        with self._lock:
            return self._tools.get(name)

    def get_registered_toolset_names(self) -> List[str]:
        """Return sorted unique toolset names present in the registry."""
        return sorted({entry.toolset for entry in self._snapshot_entries()})

    def get_tool_names_for_toolset(self, toolset: str) -> List[str]:
        """Return sorted tool names registered under a given toolset."""
        return sorted(
            entry.name for entry in self._snapshot_entries()
            if entry.toolset == toolset
        )

    def register_toolset_alias(self, alias: str, toolset: str) -> None:
        """Register an explicit alias for a canonical toolset name."""
        with self._lock:
            existing = self._toolset_aliases.get(alias)
            if existing and existing != toolset:
                plugin_identity = self._plugin_caller_identity()
                if plugin_identity and not plugin_identity[1]:
                    raise PermissionError(
                        f"Plugin {plugin_identity[2]!r} cannot replace toolset "
                        f"alias {alias!r} without "
                        f"plugins.entries.{plugin_identity[2]}.allow_tool_override: true"
                    )
                logger.warning(
                    "Toolset alias collision: '%s' (%s) overwritten by %s",
                    alias, existing, toolset,
                )
            self._toolset_aliases[alias] = toolset
            self._generation += 1

    def get_registered_toolset_aliases(self) -> Dict[str, str]:
        """Return a snapshot of ``{alias: canonical_toolset}`` mappings."""
        with self._lock:
            return dict(self._toolset_aliases)

    def get_toolset_alias_target(self, alias: str) -> Optional[str]:
        """Return the canonical toolset name for an alias, or None."""
        with self._lock:
            return self._toolset_aliases.get(alias)

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register_plugin_override_policy(
        self,
        module_namespace: str,
        allowed: bool,
        plugin_id: str | None = None,
    ) -> None:
        """Bind a plugin namespace to the operator's tool-override decision."""
        if self._caller_module() != "fan_cli.plugins":
            raise PermissionError(
                "Plugin override policy is host-owned and can only be set by "
                "fan_cli.plugins"
            )
        namespace = str(module_namespace or "").strip()
        if not namespace:
            return
        with self._lock:
            self._plugin_override_policy[namespace] = (
                bool(allowed),
                str(plugin_id or namespace),
            )

    def begin_plugin_load(
        self,
        plugin_id: str,
        allowed: bool,
        module_namespace: str = "",
    ):
        """Mark the current import/register call chain as plugin-owned.

        The transient context closes import-time direct-registry bypasses;
        :meth:`register_plugin_override_policy` provides the durable gate for
        callbacks and threads that run after loading has completed.
        """
        if self._caller_module() != "fan_cli.plugins":
            raise PermissionError(
                "Plugin load authorization is host-owned and can only be set "
                "by fan_cli.plugins"
            )
        if module_namespace:
            with self._lock:
                self._plugin_override_policy[str(module_namespace)] = (
                    bool(allowed),
                    str(plugin_id or module_namespace),
                )
        return self._active_plugin_override.set(
            (str(plugin_id), bool(allowed), str(module_namespace or ""))
        )

    def end_plugin_load(self, token) -> None:
        self._active_plugin_override.reset(token)

    @contextmanager
    def trusted_mcp_registry_mutation(self):
        """Authorize a registry mutation made by the host MCP lifecycle."""
        frame = sys._getframe(1)
        called_from_mcp_host = False
        while frame is not None:
            if str(frame.f_globals.get("__name__", "") or "") == "tools.mcp_tool":
                called_from_mcp_host = True
                break
            frame = frame.f_back
        if not called_from_mcp_host or self._plugin_caller_identity() is not None:
            raise PermissionError("MCP registry mutation is restricted to tools.mcp_tool")
        token = self._trusted_mcp_mutation.set(
            int(self._trusted_mcp_mutation.get() or 0) + 1
        )
        try:
            yield
        finally:
            self._trusted_mcp_mutation.reset(token)

    @staticmethod
    def _handler_module(handler: Callable) -> str:
        """Best-effort defining module for functions, partials and callables."""
        target = handler
        while isinstance(target, functools.partial):
            target = target.func
        module = getattr(target, "__module__", "")
        if not module:
            try:
                module = target.__globals__.get("__name__", "")  # type: ignore[attr-defined]
            except AttributeError:
                module = ""
        if not module:
            module = getattr(getattr(target, "__class__", None), "__module__", "")
        return str(module or "")

    @staticmethod
    def _caller_module() -> str:
        """Return the first caller outside this registry module."""
        try:
            frame = sys._getframe(1)
            while frame is not None:
                module = str(frame.f_globals.get("__name__", "") or "")
                if module and module != __name__:
                    return module
                frame = frame.f_back
        except Exception:
            pass
        return ""

    def _plugin_policy_for_module(
        self,
        module_name: str,
    ) -> tuple[str, bool, str] | None:
        module = str(module_name or "")
        if not module:
            return None
        matches = [
            namespace
            for namespace in self._plugin_override_policy
            if module == namespace or module.startswith(namespace + ".")
        ]
        if matches:
            namespace = max(matches, key=len)
            allowed, plugin_id = self._plugin_override_policy[namespace]
            return namespace, allowed, plugin_id
        # A Fan directory plugin that somehow executes before its policy was
        # recorded is plugin code, never unscoped core code. Fail closed.
        if module.startswith("fan_plugins."):
            parts = module.split(".")
            namespace = ".".join(parts[:2])
            return namespace, False, namespace
        return None

    def _plugin_registration_identity(
        self,
        handler: Callable,
    ) -> tuple[str, bool, str] | None:
        active = self._active_plugin_override.get()
        if active is not None:
            plugin_id, allowed, namespace = active
            return namespace or str(plugin_id), bool(allowed), str(plugin_id)
        owner = self._plugin_policy_for_module(self._handler_module(handler))
        if owner is not None:
            return owner
        return self._plugin_policy_for_module(self._caller_module())

    def _plugin_caller_identity(self) -> tuple[str, bool, str] | None:
        active = self._active_plugin_override.get()
        if active is not None:
            plugin_id, allowed, namespace = active
            return namespace or str(plugin_id), bool(allowed), str(plugin_id)
        return self._plugin_policy_for_module(self._caller_module())

    def is_plugin_owned_tool(self, name: str) -> bool:
        with self._lock:
            entry = self._tools.get(name)
            return bool(
                entry
                and self._plugin_policy_for_module(
                    self._handler_module(entry.handler)
                )
            )

    def register(
        self,
        name: str,
        toolset: str,
        schema: dict,
        handler: Callable,
        check_fn: Callable = None,
        requires_env: list = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        max_result_size_chars: int | float | None = None,
        dynamic_schema_overrides: Callable = None,
        override: bool = False,
    ):
        """Register a tool.  Called at module-import time by each tool file.

        ``override=True`` is an explicit opt-in for plugins that intend to
        replace an existing built-in tool implementation (e.g. swap the
        default browser tool for a headed-Chrome CDP backend). Without it,
        registrations that would shadow an existing tool from a different
        toolset are rejected to prevent accidental overwrites.
        """
        with self._lock:
            existing = self._tools.get(name)
            plugin_identity = self._plugin_registration_identity(handler)
            if existing:
                # Allow MCP-to-MCP overwrites (legitimate: server refresh,
                # or two MCP servers with overlapping tool names).
                both_mcp = (
                    existing.toolset.startswith("mcp-")
                    and toolset.startswith("mcp-")
                )
                existing_owner = self._plugin_policy_for_module(
                    self._handler_module(existing.handler)
                )
                same_plugin = bool(
                    plugin_identity
                    and existing_owner
                    and plugin_identity[0] == existing_owner[0]
                )
                trusted_mcp = bool(self._trusted_mcp_mutation.get())

                # Plugin identity always wins over string-shaped MCP
                # exceptions. A plugin may update its own entry, but replacing
                # any other tool requires both explicit call-site intent and a
                # literal local operator authorization.
                if plugin_identity:
                    if not same_plugin:
                        namespace, allowed, plugin_id = plugin_identity
                        if not override or not allowed:
                            logger.error(
                                "Tool registration REJECTED: plugin %r attempted "
                                "to replace tool %r (existing toolset %r) without "
                                "explicit operator opt-in",
                                plugin_id, name, existing.toolset,
                            )
                            raise PermissionError(
                                f"Plugin {plugin_id!r} cannot replace tool {name!r} "
                                "without override=True and "
                                f"plugins.entries.{plugin_id}.allow_tool_override: true"
                            )
                        logger.info(
                            "Plugin %r (%s) overriding tool %r from toolset %r",
                            plugin_id, namespace, name, existing.toolset,
                        )
                elif both_mcp:
                    if not trusted_mcp:
                        raise PermissionError(
                            f"MCP tool {name!r} can only be replaced during "
                            "trusted MCP discovery or refresh"
                        )
                    logger.debug(
                        "Tool '%s': MCP toolset '%s' overwriting MCP toolset '%s'",
                        name, toolset, existing.toolset,
                    )
                elif trusted_mcp and toolset.startswith("mcp-") and existing_owner:
                    logger.warning(
                        "MCP discovery reclaiming plugin-owned reserved tool name %r",
                        name,
                    )
                elif existing.toolset != toolset and override:
                    # Explicit plugin opt-in: replace the existing tool.
                    # Logged at INFO so the override is auditable in agent.log.
                    logger.info(
                        "Tool '%s': toolset '%s' overriding existing toolset '%s' "
                        "(override=True opt-in)",
                        name, toolset, existing.toolset,
                    )
                elif existing.toolset != toolset:
                    # Reject shadowing — prevent plugins/MCP from overwriting
                    # built-in tools or vice versa.
                    logger.error(
                        "Tool registration REJECTED: '%s' (toolset '%s') would "
                        "shadow existing tool from toolset '%s'. Pass "
                        "override=True to register() if the replacement is "
                        "intentional, or deregister the existing tool first.",
                        name, toolset, existing.toolset,
                    )
                    return
            self._tools[name] = ToolEntry(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=handler,
                check_fn=check_fn,
                requires_env=requires_env or [],
                is_async=is_async,
                description=description or schema.get("description", ""),
                emoji=emoji,
                max_result_size_chars=max_result_size_chars,
                dynamic_schema_overrides=dynamic_schema_overrides,
            )
            if check_fn and toolset not in self._toolset_checks:
                self._toolset_checks[toolset] = check_fn
            self._generation += 1

    def deregister(self, name: str) -> None:
        """Remove a tool from the registry.

        Also cleans up the toolset check if no other tools remain in the
        same toolset.  Used by MCP dynamic tool discovery to nuke-and-repave
        when a server sends ``notifications/tools/list_changed``.
        """
        with self._lock:
            entry = self._tools.get(name)
            if entry is None:
                return
            caller_identity = self._plugin_caller_identity()
            owner_identity = self._plugin_policy_for_module(
                self._handler_module(entry.handler)
            )
            same_plugin = bool(
                caller_identity
                and owner_identity
                and caller_identity[0] == owner_identity[0]
            )
            if caller_identity:
                if not same_plugin and not caller_identity[1]:
                    raise PermissionError(
                        f"Plugin {caller_identity[2]!r} cannot deregister tool "
                        f"{name!r} without "
                        f"plugins.entries.{caller_identity[2]}.allow_tool_override: true"
                    )
            elif (
                entry.toolset.startswith("mcp-")
                and not bool(self._trusted_mcp_mutation.get())
            ):
                raise PermissionError(
                    f"MCP tool {name!r} can only be deregistered during "
                    "trusted MCP lifecycle mutation"
                )
            del self._tools[name]
            # Drop the toolset check and aliases if this was the last tool in
            # that toolset.
            toolset_still_exists = any(
                e.toolset == entry.toolset for e in self._tools.values()
            )
            if not toolset_still_exists:
                self._toolset_checks.pop(entry.toolset, None)
                self._toolset_aliases = {
                    alias: target
                    for alias, target in self._toolset_aliases.items()
                    if target != entry.toolset
                }
            self._generation += 1
        logger.debug("Deregistered tool: %s", name)

    # ------------------------------------------------------------------
    # Schema retrieval
    # ------------------------------------------------------------------

    def get_definitions(self, tool_names: Set[str], quiet: bool = False) -> List[dict]:
        """Return OpenAI-format tool schemas for the requested tool names.

        Only tools whose ``check_fn()`` returns True (or have no check_fn)
        are included. ``check_fn()`` results are cached for ~30 s via
        :func:`_check_fn_cached` to amortize repeat probes (check_terminal_
        requirements probes modal/docker, browser checks probe playwright,
        etc.); TTL chosen so env-var changes (``fan tools enable foo``)
        still take effect in near-real-time without forcing a full cache
        flush on every call.
        """
        result = []
        # Per-call cache on top of the 30 s TTL — handles repeat probes of the
        # same check_fn within one definitions pass without re-reading the
        # TTL clock.
        check_results: Dict[Callable, bool] = {}
        entries_by_name = {entry.name: entry for entry in self._snapshot_entries()}
        for name in sorted(tool_names):
            entry = entries_by_name.get(name)
            if not entry:
                continue
            if entry.check_fn:
                if entry.check_fn not in check_results:
                    check_results[entry.check_fn] = _check_fn_cached(entry.check_fn)
                if not check_results[entry.check_fn]:
                    if not quiet:
                        logger.debug("Tool %s unavailable (check failed)", name)
                    continue
            # Ensure schema always has a "name" field — use entry.name as fallback
            schema_with_name = {**entry.schema, "name": entry.name}
            # Apply runtime-dynamic overrides (e.g. delegate_task description
            # depends on current delegation.max_concurrent_children /
            # max_spawn_depth). Caller side (model_tools.get_tool_definitions)
            # already keys its memo on config.yaml mtime + size, so changes
            # to delegation.* in config invalidate the cache automatically.
            if entry.dynamic_schema_overrides is not None:
                try:
                    overrides = entry.dynamic_schema_overrides()
                    if isinstance(overrides, dict):
                        schema_with_name.update(overrides)
                except Exception as exc:
                    logger.warning(
                        "dynamic_schema_overrides for tool %s raised %s; "
                        "using static schema",
                        name, exc,
                    )
            result.append({"type": "function", "function": schema_with_name})
        return result

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_handler_result(name: str, result):
        """Enforce the result contract consumed by the agent pipeline."""
        if isinstance(result, str):
            return result
        if (
            isinstance(result, dict)
            and result.get("_multimodal") is True
            and isinstance(result.get("content"), list)
        ):
            return result

        result_type = type(result).__name__
        logger.error(
            "Tool %s handler returned unsupported result type: %s",
            name,
            result_type,
        )
        return json.dumps(
            {
                "error": f"Tool handler returned unsupported result type: {result_type}",
                "error_type": "tool_result_contract",
                "tool": name,
                "result_type": result_type,
            },
            ensure_ascii=False,
        )

    def dispatch(self, name: str, args: dict, **kwargs) -> str | dict:
        """Execute a tool handler by name.

        * Async handlers are bridged automatically via ``_run_async()``.
        * Results are normalized to text or the supported multimodal envelope.
        * All exceptions are caught and returned as ``{"error": "..."}``
          for consistent error format.
        """
        entry = self.get_entry(name)
        if not entry:
            return json.dumps({"error": f"Unknown tool: {name}"})
        try:
            if entry.is_async:
                from model_tools import _run_async
                result = _run_async(entry.handler(args, **kwargs))
            else:
                result = entry.handler(args, **kwargs)
            return self._normalize_handler_result(name, result)
        except Exception as e:
            logger.exception("Tool %s dispatch error: %s", name, e)
            # Route through the sanitizer so framing tokens / CDATA / fences
            # in exception strings don't reach the model as structural noise.
            # See model_tools._sanitize_tool_error for rationale.
            raw = f"Tool execution failed: {type(e).__name__}: {e}"
            try:
                from model_tools import _sanitize_tool_error
                sanitized = _sanitize_tool_error(raw)
            except Exception:
                sanitized = raw  # defensive: never let the sanitizer block error propagation
            return json.dumps({"error": sanitized})

    # ------------------------------------------------------------------
    # Query helpers  (replace redundant dicts in model_tools.py)
    # ------------------------------------------------------------------

    def get_max_result_size(self, name: str, default: int | float | None = None) -> int | float:
        """Return per-tool max result size, or *default* (or global default)."""
        entry = self.get_entry(name)
        if entry and entry.max_result_size_chars is not None:
            return entry.max_result_size_chars
        if default is not None:
            return default
        from tools.budget_config import DEFAULT_RESULT_SIZE_CHARS
        return DEFAULT_RESULT_SIZE_CHARS

    def get_all_tool_names(self) -> List[str]:
        """Return sorted list of all registered tool names."""
        return sorted(entry.name for entry in self._snapshot_entries())

    def get_schema(self, name: str) -> Optional[dict]:
        """Return a tool's raw schema dict, bypassing check_fn filtering.

        Useful for token estimation and introspection where availability
        doesn't matter — only the schema content does.
        """
        entry = self.get_entry(name)
        return entry.schema if entry else None

    def get_toolset_for_tool(self, name: str) -> Optional[str]:
        """Return the toolset a tool belongs to, or None."""
        entry = self.get_entry(name)
        return entry.toolset if entry else None

    def get_emoji(self, name: str, default: str = "⚡") -> str:
        """Return the emoji for a tool, or *default* if unset."""
        entry = self.get_entry(name)
        return (entry.emoji if entry and entry.emoji else default)

    def get_tool_to_toolset_map(self) -> Dict[str, str]:
        """Return ``{tool_name: toolset_name}`` for every registered tool."""
        return {entry.name: entry.toolset for entry in self._snapshot_entries()}

    def is_toolset_available(self, toolset: str) -> bool:
        """Check if a toolset's requirements are met.

        Returns False (rather than crashing) when the check function raises
        an unexpected exception (e.g. network error, missing import, bad config).
        """
        with self._lock:
            check = self._toolset_checks.get(toolset)
        return self._evaluate_toolset_check(toolset, check)

    def check_toolset_requirements(self) -> Dict[str, bool]:
        """Return ``{toolset: available_bool}`` for every toolset."""
        entries, toolset_checks = self._snapshot_state()
        toolsets = sorted({entry.toolset for entry in entries})
        return {
            toolset: self._evaluate_toolset_check(toolset, toolset_checks.get(toolset))
            for toolset in toolsets
        }

    def get_available_toolsets(self) -> Dict[str, dict]:
        """Return toolset metadata for UI display."""
        toolsets: Dict[str, dict] = {}
        entries, toolset_checks = self._snapshot_state()
        for entry in entries:
            ts = entry.toolset
            if ts not in toolsets:
                toolsets[ts] = {
                    "available": self._evaluate_toolset_check(
                        ts, toolset_checks.get(ts)
                    ),
                    "tools": [],
                    "description": "",
                    "requirements": [],
                }
            toolsets[ts]["tools"].append(entry.name)
            if entry.requires_env:
                for env in entry.requires_env:
                    if env not in toolsets[ts]["requirements"]:
                        toolsets[ts]["requirements"].append(env)
        return toolsets

    def get_toolset_requirements(self) -> Dict[str, dict]:
        """Build a TOOLSET_REQUIREMENTS-compatible dict for backward compat."""
        result: Dict[str, dict] = {}
        entries, toolset_checks = self._snapshot_state()
        for entry in entries:
            ts = entry.toolset
            if ts not in result:
                result[ts] = {
                    "name": ts,
                    "env_vars": [],
                    "check_fn": toolset_checks.get(ts),
                    "setup_url": None,
                    "tools": [],
                }
            if entry.name not in result[ts]["tools"]:
                result[ts]["tools"].append(entry.name)
            for env in entry.requires_env:
                if env not in result[ts]["env_vars"]:
                    result[ts]["env_vars"].append(env)
        return result

    def check_tool_availability(self, quiet: bool = False):
        """Return (available_toolsets, unavailable_info) like the old function."""
        available = []
        unavailable = []
        seen = set()
        entries, toolset_checks = self._snapshot_state()
        for entry in entries:
            ts = entry.toolset
            if ts in seen:
                continue
            seen.add(ts)
            if self._evaluate_toolset_check(ts, toolset_checks.get(ts)):
                available.append(ts)
            else:
                unavailable.append({
                    "name": ts,
                    "env_vars": entry.requires_env,
                    "tools": [e.name for e in entries if e.toolset == ts],
                })
        return available, unavailable


# Module-level singleton
registry = ToolRegistry()


# ---------------------------------------------------------------------------
# Helpers for tool response serialization
# ---------------------------------------------------------------------------
# Every tool handler must return a JSON string.  These helpers eliminate the
# boilerplate ``json.dumps({"error": msg}, ensure_ascii=False)`` that appears
# hundreds of times across tool files.
#
# Usage:
#   from tools.registry import registry, tool_error, tool_result
#
#   return tool_error("something went wrong")
#   return tool_error("not found", code=404)
#   return tool_result(success=True, data=payload)
#   return tool_result(items)            # pass a dict directly


def tool_error(message, **extra) -> str:
    """Return a JSON error string for tool handlers.

    >>> tool_error("file not found")
    '{"error": "file not found"}'
    >>> tool_error("bad input", success=False)
    '{"error": "bad input", "success": false}'
    """
    result = {"error": str(message)}
    if extra:
        result.update(extra)
    return json.dumps(result, ensure_ascii=False)


def tool_result(data=None, **kwargs) -> str:
    """Return a JSON result string for tool handlers.

    Accepts a dict positional arg *or* keyword arguments (not both):

    >>> tool_result(success=True, count=42)
    '{"success": true, "count": 42}'
    >>> tool_result({"key": "value"})
    '{"key": "value"}'
    """
    if data is not None:
        return json.dumps(data, ensure_ascii=False)
    return json.dumps(kwargs, ensure_ascii=False)
