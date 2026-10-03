import math
from fractions import Fraction

S = 10**18

def half_up_div(num: int, den: int) -> int:
    neg = (num < 0) != (den < 0)
    n, d = abs(num), abs(den)
    q, r = divmod(n, d)
    if 2 * r >= d:
        q += 1
    return -q if neg else q

def from_scaled(num: int, digits: int) -> int:
    # value = num / 10**digits -> raw = value * S
    if digits <= 18:
        return num * 10 ** (18 - digits)
    return half_up_div(num, 10 ** (digits - 18))

def mul_r(a: int, b: int) -> int:
    return half_up_div(a * b, S)

def div_r(a: int, b: int) -> int:
    return half_up_div(a * S, b)

def mean_r(values):
    return half_up_div(sum(values), len(values))

def sqrt_r(a: int) -> int:
    # largest g with g^2 <= a*S (floor of exact root), a >= 0 — mirrors Decimal.sqrt
    return math.isqrt(a * S)

def sharpe(returns, rf=0, mode="population"):
    m = mean_r(returns)
    ss = sum(mul_r(r - m, r - m) for r in returns)
    n = len(returns)
    den = n if mode == "population" else n - 1
    var = half_up_div(ss, den)
    sd = sqrt_r(var)
    return div_r(m - rf, sd), m, var, sd

def var_of(returns, c):
    n = len(returns)
    k = ((S - c) * n + S - 1) // S  # ceil((1-c)*n) in raw arithmetic
    s = sorted(returns)
    k = max(1, min(k, n))
    return -s[k-1], k

def fr_to_raw(fr: Fraction) -> int:
    # exact rational -> scale-18 raw, half-up (the ideal a hand-worker writes)
    num, den = fr.numerator * S, fr.denominator
    return half_up_div(num, den)

# ── Series A: portfolio values 100,110,105,90,95,120,115 ──
vals = ["100","110","105","90","95","120","115"]
V = [int(v)*S for v in vals]
R = [half_up_div((V[i] - V[i-1]) * S, V[i-1]) for i in range(1, 7)]
print("returnsA raw:", R)
FR = [Fraction(V[i] - V[i-1], V[i-1]) for i in range(1,7)]
print("returnsA exact fractions:", FR)

peak = 0; dd = []
for v in V:
    if v > peak: peak = v
    dd.append(half_up_div((v - peak) * S, peak))
print("ddA raw:", dd)
print("maxDD raw:", min(dd), "exact -2/11 raw:", fr_to_raw(Fraction(-2, 11)))

sh0, meanA, varA_pop, sdA_pop = sharpe(R)
print("meanA raw:", meanA, "exact:", fr_to_raw(sum(FR)/6))
print("varA_pop raw:", varA_pop, "sdA_pop raw:", sdA_pop)
print("sharpeA rf=0 raw:", sh0)
rf = from_scaled(1, 3)  # 0.001
sh_rf, _, _, _ = sharpe(R, rf=rf)
print("sharpeA rf=0.001 raw:", sh_rf)
sh_s, _, varA_s, sdA_s = sharpe(R, mode="sample")
print("varA_sample raw:", varA_s, "sdA_sample raw:", sdA_s)
print("sharpeA sample rf=0 raw:", sh_s)

# annualize: sqrt(365) raw = isqrt(365 * S * S); annualized = mul_r(sh0, sqrt365_raw)
sqrt365 = math.isqrt(365 * S * S)
print("sqrt365 raw:", sqrt365)
ann = mul_r(sh0, sqrt365)
print("annualized sharpeA rf=0 raw:", ann)
print("float cross-check annualized:", float(sum(FR)/6) / math.sqrt(float(sum((r-sum(FR)/6)**2 for r in FR))/6) * math.sqrt(365))

v95, k95 = var_of(R, from_scaled(95, 2))
v80, k80 = var_of(R, from_scaled(80, 2))
v90, k90 = var_of(R, from_scaled(90, 2))
print(f"VaR95 A: k={k95} raw={v95}; VaR90 A: k={k90} raw={v90}; VaR80 A: k={k80} raw={v80}")
print("sortedA raw:", sorted(R))

# ── Series B: symmetric ±5%, rf=1% ──
B = [from_scaled(5,2), from_scaled(-5,2), from_scaled(5,2), from_scaled(-5,2)]
shb, mb, vb, sdb = sharpe(B, rf=from_scaled(1,2))
print("\nB mean:", mb, "var:", vb, "sd:", sdb)
print("sharpeB pop rf=0.01 raw:", shb)
shbs, _, vbs, sdbs = sharpe(B, rf=from_scaled(1,2), mode="sample")
print("B sample var raw:", vbs, "sd raw:", sdbs)
print("sharpeB sample rf=0.01 raw:", shbs)

# ── Series C: VaR order statistics, n=5 ──
C = [from_scaled(-1,2), from_scaled(3,2), from_scaled(-7,2), from_scaled(2,2), from_scaled(-5,2)]
print("\nsortedC raw:", sorted(C))
for c_pct in (99, 95, 90, 80, 60, 50, 40, 30, 20, 10):
    v, k = var_of(C, from_scaled(c_pct, 2))
    print(f"VaR{c_pct}: k={k} raw={v}")
