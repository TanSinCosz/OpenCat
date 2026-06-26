#include <iostream>
#include <algorithm>
#include <cmath>
using namespace std;

typedef long long ll;
const int MAXN = 500010;

// ============ 树状数组 (获取 A[i]) ============
ll bit[MAXN];
int n;

void bit_add(int idx, ll val) {
    for (; idx <= n; idx += idx & -idx)
        bit[idx] += val;
}

ll bit_sum(int idx) {
    ll res = 0;
    for (; idx > 0; idx -= idx & -idx)
        res += bit[idx];
    return res;
}

// ============ 线段树 (维护差分数组的区间GCD) ============
ll seg[4 * MAXN];
ll diff[MAXN];

void seg_build(int p, int l, int r) {
    if (l == r) {
        seg[p] = diff[l];
        return;
    }
    int mid = (l + r) >> 1;
    seg_build(p << 1, l, mid);
    seg_build(p << 1 | 1, mid + 1, r);
    seg[p] = __gcd(seg[p << 1], seg[p << 1 | 1]);
}

void seg_update(int p, int l, int r, int idx, ll val) {
    if (l == r) {
        seg[p] += val;
        return;
    }
    int mid = (l + r) >> 1;
    if (idx <= mid)
        seg_update(p << 1, l, mid, idx, val);
    else
        seg_update(p << 1 | 1, mid + 1, r, idx, val);
    seg[p] = __gcd(seg[p << 1], seg[p << 1 | 1]);
}

ll seg_query(int p, int l, int r, int ql, int qr) {
    if (ql > qr) return 0;
    if (ql <= l && r <= qr)
        return seg[p];
    int mid = (l + r) >> 1;
    ll left_gcd = 0, right_gcd = 0;
    if (ql <= mid)
        left_gcd = seg_query(p << 1, l, mid, ql, qr);
    if (qr > mid)
        right_gcd = seg_query(p << 1 | 1, mid + 1, r, ql, qr);
    if (!left_gcd) return right_gcd;
    if (!right_gcd) return left_gcd;
    return __gcd(left_gcd, right_gcd);
}

// ============ 主函数 ============
int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int m;
    cin >> n >> m;

    ll prev = 0;
    for (int i = 1; i <= n; i++) {
        ll a;
        cin >> a;
        diff[i] = a - prev;
        bit_add(i, diff[i]);
        prev = a;
    }

    seg_build(1, 1, n);

    while (m--) {
        char op;
        cin >> op;
        if (op == 'C') {
            int l, r;
            ll d;
            cin >> l >> r >> d;
            bit_add(l, d);
            seg_update(1, 1, n, l, d);
            if (r + 1 <= n) {
                bit_add(r + 1, -d);
                seg_update(1, 1, n, r + 1, -d);
            }
        } else {
            int l, r;
            cin >> l >> r;
            ll a_l = bit_sum(l);
            ll b_gcd = seg_query(1, 1, n, l + 1, r);
            cout << abs(__gcd(a_l, b_gcd)) << '\n';
        }
    }
    return 0;
}
