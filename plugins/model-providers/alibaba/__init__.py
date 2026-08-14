"""Alibaba Cloud DashScope provider profile."""

from providers import register_provider
from providers.base import ProviderProfile

alibaba = ProviderProfile(
    name="alibaba",
    aliases=("dashscope", "alibaba-cloud", "qwen-dashscope"),
    env_vars=("DASHSCOPE_API_KEY",),
    # China endpoint. The intl endpoint (dashscope-intl…) is unreachable from
    # this deployment; China mainland accounts must use this host. Verified in
    # M0 spike (intl → connection timeout, China → 200).
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)

register_provider(alibaba)
