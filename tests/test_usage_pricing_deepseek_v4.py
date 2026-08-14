from decimal import Decimal

from agent.usage_pricing import CanonicalUsage, estimate_usage_cost, get_pricing_entry


def test_deepseek_v4_pro_official_price_distinguishes_cache_hits():
    pricing = get_pricing_entry("deepseek-v4-pro", provider="deepseek")

    assert pricing is not None
    assert pricing.input_cost_per_million == Decimal("0.435")
    assert pricing.cache_read_cost_per_million == Decimal("0.003625")
    assert pricing.output_cost_per_million == Decimal("0.87")

    result = estimate_usage_cost(
        "deepseek-v4-pro",
        CanonicalUsage(
            input_tokens=50_616,
            cache_read_tokens=361_472,
            output_tokens=2_190,
        ),
        provider="deepseek",
    )

    assert result.amount_usd == Decimal("0.025233596")
    assert result.status == "estimated"


def test_deepseek_v4_flash_official_price_is_available():
    pricing = get_pricing_entry("deepseek-v4-flash", provider="deepseek")

    assert pricing is not None
    assert pricing.input_cost_per_million == Decimal("0.14")
    assert pricing.cache_read_cost_per_million == Decimal("0.0028")
    assert pricing.output_cost_per_million == Decimal("0.28")
