# Authored clip-coordinate enclosure prerequisite

This is a pure CPU prerequisite for issue [#18](https://github.com/tylerstuff/strata/issues/18). It does not enable renderer culling. Scene admission, GPU buffers, shaders, submitted history, and public metadata remain unchanged. Unsupported arithmetic means retain the admitted box. In particular, this helper's coefficient domain must never reject a valid scene or weaken its existing 1024-resident-box and ±4096-metre camera-relative admission limits.

The input is the actual pair of column-major `Float32Array` matrices uploaded by the current authored renderer. The shader computes `relative = model * vec4f(input.position, 1)` and then `position = viewProjection * relative`. Every mesh position is one of the eight combinations of ±0.5. An enclosure record contains lower XYZW followed by upper XYZW for one corner; corner bits 0, 1, and 2 select the positive X, Y, and Z coordinates. Neither ideal f64 transformed AABBs nor world-space epsilons establish bounds for this expression.

## Floating-point contract

The proof is pinned to the [31 August 2026 WGSL draft, sections 15.7.2–15.7.5](https://www.w3.org/TR/2026/CRD-WGSL-20260831/#floating-point-evaluation). Basic f32 sums and products may round in either direction. Operations may be regrouped; fusion must be at least as accurate. Subnormal operands/results can become zero, and runtime overflow can yield an indeterminate result. Consequently, two source-level matrix operations do not establish two mandatory rounding barriers.

The enclosure covers scalar expansion of the existing sum/product expression, additive permutations and binary parenthesizations, multiplication regrouping, distribution/factoring of its terms, and matrix-chain regrouping to `(viewProjection * model) * point`. It also covers fusion or higher-accuracy evaluation. “Reassociation” here means reordering the existing arithmetic, as specified by WGSL. It does not mean introducing arbitrary new canceling terms, divisions, or unrelated expressions. No such operations occur in the vertex-position expression.

## Checked arithmetic domain

Every matrix must be a `Float32Array` with exactly 16 entries, backed by ordinary memory. Shared buffers are unsupported because another agent could change coefficients between validation and evaluation. Every coefficient must be finite and either zero or have magnitude in **[2^-30, 2^20]**, inclusive. Values outside this domain return `supported: false`; a caller retains that box. These limits are deliberately narrower than all possible legal authored matrices. For example, an extremely small nonzero rotation coefficient or a strongly amplified projection matrix can make selection unavailable without changing admission or rendering.

For any accepted f32 coefficient, its exact value is an integer multiple of **2^-53**: the smallest admitted exponent is -30 and f32 has 23 fractional significand bits. The point coordinates are ±1/2 or 1. Each scalar clip result is a sum of 16 monomials, each containing two matrix coefficients and one point coordinate. All exact products and sums in every regrouping therefore lie on the **2^-107** lattice or a coarser lattice.

Rounding cannot break this property. If an exact lattice value needs fewer than 24 significant bits, f32 represents it exactly; otherwise f32 spacing is coarser than that lattice. Thus every rounded intermediate also lies on the same lattice. Every nonzero intermediate has magnitude at least 2^-107, above f32's minimum normal value 2^-126. This rules out subnormal inputs, outputs, and intermediate results for all admitted regroupings; signed zero has no effect on real-coordinate bounds. The argument includes exact cancellation to zero and does not require a non-cancellation assumption.

The sum of absolute values of all 16 degree-three monomials is at most `16 * 2^20 * 2^20 * 1 = 2^44`. Lower-degree partial expressions obey the same loose upper bound. The rounding amplification derived below is less than two, so every possible intermediate has magnitude below **2^45**, far below f32 overflow. No infinity or NaN can arise in this finite sum/product expression. The finite-math assumption therefore cannot make this result indeterminate within the checked domain.

## Error bound over regroupings

For one output component and one corner, write the exact polynomial as

```text
P = sum(j=0..3, k=0..3) V[row,j] * M[j,k] * p[k]
S = sum(j=0..3, k=0..3) abs(V[row,j] * M[j,k] * p[k])
u = 2^-23
gamma47 = (47*u) / (1 - 47*u)
```

Directed f32 rounding of a normal result is representable as `fl(t) = t * (1 + delta)`, with `abs(delta) <= u`; exact zero stays zero. The full expansion has 32 scalar multiplications and 15 additions. Any monomial collects at most **47** rounding factors along its contributing operations. This deliberately counts the entire expanded expression, not merely one assumed evaluation path. Factoring or the original nested matrix-vector evaluation uses fewer operations; expanding a factored expression for analysis copies error factors but does not increase their count along any one monomial beyond this bound. Permuting or regrouping the same operations cannot exceed it.

Expand the rounded expression symbolically. Each exact signed monomial is multiplied by a product of at most 47 factors `(1 + delta)`. The standard product inequality follows by bounding that product between `(1-u)^47` and `(1+u)^47`; its distance from one is at most `47*u/(1-47*u)` because `47*u < 1`. Applying the triangle inequality gives

```text
abs(rounded_P - P) <= gamma47 * S.
```

The same positive bound applied to each intermediate gives the overflow bound above. This is not a simulation of a particular GPU summation order. Rounding may choose its direction independently at each operation. The bound permits different choices for duplicate cube vertices and different components.

Fusion does not need to improve the final composite answer: a smaller local error can change later cancellation. A correctly rounded fused block contributes only its final rounding factor, fitting within the unfused operation budget. More generally, a permitted fused block's local absolute error is no worse than that block's unfused `gammaK * Sblock` bound. Propagate this local error using absolute sums and products, just as above. Combining blocks and subsequent rounding uses `(1 + gammaA) * (1 + gammaB) <= 1 + gamma(A+B)` when `(A+B)*u < 1`. Charging each fused block its original operation count therefore retains the same 47-operation total bound, regardless of the sign of its local error or later cancellation. The proof does not assert that locally better arithmetic necessarily improves the final answer.

## Outward host arithmetic

Each monomial is exactly representable in binary64: two f32 significands require at most 48 bits and multiplication by ±1/2 or 1 changes only sign/exponent. The checked exponents rule out binary64 underflow and overflow. The implementation surrounds the exact polynomial sum using `nextDown` and `nextUp` after every binary64 addition. It accumulates `S` upward, rounds the computed `gamma47` upward, and rounds the radius product upward. Final lower subtraction and upper addition are stepped outward once more. Adjacent binary64 values are obtained by adjusting their IEEE-754 bit patterns, including negative values and both signed zeros; they are not approximated with a relative epsilon.

The numerator `47*u` and denominator `1-47*u` are exact binary64 values. One upward step encloses their rounded quotient. This accounts for all host rounding used in the bound, rather than assuming double precision is exact under cancellation. A polynomial whose every monomial is zero returns exact zero bounds.

## Intended selector acceptance

A box can be rejected only if one common homogeneous halfspace is strictly outside for all eight enclosed corners: `x+w`, `w-x`, `y+w`, `w-y`, `z`, or `w-z`. The selector must evaluate these sums/subtractions outward as well. Bounds touching zero, tangencies, thin slivers, unsupported arithmetic, and uncertain cases remain retained. It must not divide by W or conclude invisibility because no corner is inside. Once every rounded triangle vertex is strictly outside one common linear halfspace, its entire triangle is outside that halfspace.

This prerequisite says nothing about residency, upload reduction, temporal-history pruning, streaming, occlusion, frame time, or GPU performance. Eventual draw selection must retain every resident current/prior upload slot and advance all submitted transforms even on an all-culled frame; re-entry must use the immediately preceding submitted frame. Ordered draw runs and a full-draw fallback remain separate selector responsibilities. Renderer enabling requires independent source review and subsequently scheduled GPU equivalence validation, including complete color/depth/motion comparisons at boundaries.
