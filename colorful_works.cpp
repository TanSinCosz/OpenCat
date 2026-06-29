#include <bits/stdc++.h>
using namespace std;
using ll = long long;
using u64 = uint64_t;

struct Bitset {
    vector<u64> bits;
    int sz, words;
    Bitset(int n) : sz(n), words((n + 63) / 64) { bits.assign(words, 0); }
    void set(int p) { if (p >= 0 && p < sz) bits[p >> 6] |= (1ULL << (p & 63)); }
    bool get(int p) const {
        if (p < 0 || p >= sz) return false;
        return (bits[p >> 6] >> (p & 63)) & 1ULL;
    }
    // this ^= (this << shift), truncating to sz bits. Optimized to skip no-op words.
    void xor_shift(int shift) {
        if (shift <= 0 || shift >= sz) return;
        int ws = shift >> 6, bs = shift & 63;
        // Only process words that change: i >= ws
        // For i < ws, v=0 so bits[i] stays the same.
        for (int i = words - 1; i >= ws; i--) {
            u64 v = bits[i - ws] << bs;
            if (bs && i - ws > 0)
                v |= bits[i - ws - 1] >> (64 - bs);
            if (i == words - 1) {
                int rem = sz - (i << 6);
                if (rem < 64) v &= (1ULL << rem) - 1;
            }
            bits[i] ^= v;
        }
    }
};

void solve() {
    int n; cin >> n;
    vector<int> l(n), r(n);
    int max_r = 0;
    ll R_total = 0;
    for (int i = 0; i < n; i++) {
        cin >> l[i] >> r[i];
        max_r = max(max_r, r[i]);
        R_total += r[i];
    }

    // Classify colors and build cnt[d] = frequency of Δ = r_i - (l_i-1)
    ll B_total = 0;   // sum of all b_i (where b_i = l_i-1 for var, r_i for fixed)
    int V_cnt = 0;    // number of variable colors
    vector<int> cnt(2 * max_r + 2, 0);  // carry method may need up to 2*max_r

    for (int i = 0; i < n; i++) {
        if (l[i] == 0) {
            B_total += r[i];            // fixed: b_i = r_i
        } else {
            int di = r[i] - (l[i] - 1); // Δ_i
            B_total += l[i] - 1;        // b_i = l_i-1
            cnt[di]++; V_cnt++;
        }
    }

    // ---- Parity term ----
    int ans = 0;
    if (V_cnt == 0) {
        bool dom = false;
        for (int ri : r) if (2LL * ri > R_total) { dom = true; break; }
        cout << ((!dom && R_total % 2 == 0) ? 1 : 0) << '\n';
        return;
    }
    if (V_cnt == 1) {
        for (int d = 1; d <= max_r; d++)
            if (cnt[d]) { if (d & 1) { ans = 1; } break; }
    }
    // V_cnt >= 2: parity term = 0

    // ---- Build P(x) = ∏ (1+x^Δ) in GF(2) via carry propagation ----
    // Carry method: (1+x^d)^2 = 1+x^{2d} in GF(2), so we can merge pairs.
    // For each d: if cnt[d] is odd → apply (1+x^d). cnt[d]/2 carries to cnt[2d].
    int sz = 2 * max_r + 1;
    Bitset P(sz);
    P.set(0);

    for (int d = 1; d <= 2 * max_r; d++) {
        if (cnt[d] & 1) P.xor_shift(d);  // apply factor (1+x^d) if count is odd
        int carry = cnt[d] >> 1;
        if (carry && 2 * d <= 2 * max_r) cnt[2 * d] += carry;
    }

    // ---- Prefix parity sums of P ----
    // pe[s] = XOR of P.get(t) for even t <= s
    // po[s] = XOR of P.get(t) for odd  t <= s
    vector<int> pe(sz, 0), po(sz, 0);
    int es = 0, os = 0;
    for (int s = 0; s < sz; s++) {
        if (P.get(s)) { if (s & 1) os ^= 1; else es ^= 1; }
        pe[s] = es; po[s] = os;
    }

    // ---- Dominant contributions ----
    // For each color p: contribution = XOR_{k >= 1} coeff_P[Kp - 2k]
    //   = XOR_{0 <= s < Kp, s ≡ Kp (mod 2)} coeff_P[s]
    //   = pref_{Kp parity}[Kp - 2]  (if Kp >= 2)
    // where Kp = b_p + c_p - B_total
    for (int i = 0; i < n; i++) {
        ll bi, ci;
        if (l[i] == 0) bi = ci = r[i];
        else { bi = l[i] - 1; ci = r[i]; }

        ll Kp = bi + ci - B_total;
        if (Kp >= 2) {
            int e = (int)(Kp - 2);
            if (Kp & 1) ans ^= po[e];
            else        ans ^= pe[e];
        }
    }

    cout << ans << '\n';
}

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int t; cin >> t;
    while (t--) solve();
    return 0;
}
