# Fan Agent Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@xingfan.com**. Do not
open a public issue until the maintainers have had a reasonable opportunity to
investigate and release a fix.

A useful report includes the affected version or commit, operating system,
reproduction steps, impact, and the relevant file paths.

## Current security model

Fan Agent is a single-user desktop application. The Electron renderer talks to
the local Electron main process and local Python backend. Local HTTP,
WebSocket, and JSON-RPC services must bind to loopback and authenticate their
desktop client where the protocol supports it.

The default terminal backend executes with the permissions of the user who
started Fan. It is not a security sandbox. Users who need isolation should run
Fan or its terminal backend inside an operating-system-level sandbox or
container with deliberately restricted files, processes, credentials, and
network access.

Skills, plugins, MCP servers, and command-line tools may execute code with the
same permissions as the Fan process. Install only sources you trust and review
their code and scripts before enabling them.

Approval prompts, command scanning, secret redaction, and Skills Guard are
safety aids. They reduce accidental exposure but do not create a containment
boundary against malicious code or adversarial model output.

## In scope

- Unauthorized access to a local desktop or backend control surface.
- A non-loopback network bind that occurs without an explicit user choice.
- Credential or session-token disclosure caused by Fan logging, persistence,
  IPC, browser integration, or subprocess environment handling.
- A bypass of a documented OS-level isolation configuration.
- Unsafe update or package verification that permits untrusted code execution.
- Vulnerabilities in bundled browser automation that cross Electron or browser
  process security boundaries.

## Out of scope

- Behavior that requires the user to install and run an untrusted skill,
  plugin, MCP server, model provider, or executable.
- General prompt injection that does not cross a documented security boundary.
- Denial of service caused solely by an intentionally unrestricted local
  terminal command.
- Reports that only identify a vulnerable dependency without showing that the
  affected code path is reachable in Fan.

## Privacy defaults

The open-source build does not send product analytics, support conversations,
or diagnostic bundles to a Fan-operated service. Crash capture and support
bundles remain local unless the user explicitly chooses how to share a file.

Provider requests and optional integrations are sent directly to the external
services configured by the user and are governed by those services' policies.

## Supported versions

Security fixes are made on the active development branch and included in the
next published release. Older releases may no longer receive fixes once a
replacement release is available.
