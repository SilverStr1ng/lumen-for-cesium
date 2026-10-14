# R9 receiver contract

This adapter is opt-in for opaque, untextured-normal, metallic-roughness
convex sphere primitives registered by the Ball Pool descriptor. It does not
enable arbitrary shading normals or normal maps. Existing planar receivers
retain their original gates and geometry barriers.

For a receiver at P, geometric normal Ng and shading normal Ns, the estimated
linear diffuse irradiance is

`E = integral L(P + epsilon Ng, w) max(0, Ns.w) 1[Ng.w > 0] dw`.

Cosine sampling uses `pdf = max(0, Ns.w) / pi`. Each ray contributes `pi L/N`,
or zero when it lies behind Ng. Those zeros remain in N; they are known zero,
not Unknown, and are never resampled or renormalized. Ng offsets the origin.
Ng = Ns reduces to the R7/R8 estimator. A white constant environment produces
`pi (1 + dot(Ng,Ns))/2`; this contract cannot increase white-furnace energy.
The supported receiver subset limits Ng/Ns to 30 degrees. Hit-side transport
continues to use triangle Ng Lambert shading, including the independent
finite-depth reference. This is not a general shading-normal transport fix.

Two octahedral normal pairs occupy the existing RGBA32F receiver normal
attachment. Local positions and stable surface ownership stay RGBA32F.
Temporal normal guides use RGBA16F octahedral pairs; their angular error must
be measured. No additional texture sampler or position quantization is used.
Unregistered primitives keep the original Ng~Ns restriction. A primitive's
identity is independent of material identity; registered sphere owners occupy
a separate integer namespace.

Only tightly bounded, same-owner convex sphere neighbors can use the curved
surface connection. It checks both normals, chord/tangent consistency, local
distance and depth. The chord through the sphere interior is not a free-space
ray. Other balls, container surfaces and unknown geometry cannot share this
connection. All planar 5mm/segment constraints remain unchanged. Unsupported
neighborhoods keep raw or valid temporal E instead of borrowing across owners.

The registered subset uses radius 0.34m, at least 16 longitudinal / 8 latitudinal
divisions. At each triangulated endpoint, the radial-normal predicted center
differs by at most `r (1-cos(sqrt(2)*pi/16))` plus 1.5mm for the verified half-float
normal guide error. The pair checks this center agreement, owner, both Ng/Ns
hemispheres, a maximum 18.2-degree Ns neighborhood and screen footprint. Temporal
and spatial filtering retain the tighter 5.7-degree Ns neighborhood; only final
upsampling uses the wider verified convex-patch correspondence. This geometric
bound does not enable borrowing between balls or loosen planar barriers.

Physics preview disables and destroys the old local world and FG history before
moving a node. Pause stops physics only. Freeze captures one descriptor revision
and rebuilds one static world. Generation tokens prohibit an old asynchronous
model/world completion from enabling lighting on a newer pose. Display, physics
colliders and frozen GI derive from that descriptor, in local metres, z-up.

R8 fixed32 thresholds and its failed recommendation remain in force. A separate
interactive16 preset trades rays per frame for convergence time; it is not a
same-quality acceleration. All additional FG resources, normal guides, geometry
and replacement peaks are reported within the unchanged 64MiB budget.

The shared normal/sampling contract and sphere coverage do not guarantee that
the inherited sparse DDGI hit-side input is accurate at every contact. The
dedicated foreground, floor-contact and dual-ball regions retain their actual
independent finite-path errors, including failures, without excluding unsupported
receiver pixels from coverage. The full-resolution diagnostic owner marks floor
identity and the 4cm near-floor band from the fragment position, independently
of the low receiver validity. A separate low contact camera supplements the
original close view; both remain in acceptance. High-sample query evidence can
distinguish inherited input bias from reconstruction error. See the user progress
report for the tested limits; this adapter is experimental while those gates fail.
