#!/usr/bin/env python3
"""Generate a small, entirely fictional IFC4.3 (IFC4X3_ADD2) demo bridge.

  python3 scripts/make_demo_ifc.py samples/demo-bridge.ifc

What it contains (US survey-style feet, state-plane-sized coordinates):
  * IfcAlignment "CL Demo Rte" - tangent, clothoid, 1500 ft curve, clothoid,
    tangent - with a vertical profile (grade, parabolic crest, grade) and a
    start station of 100+00 (IfcReferent + Pset_Stationing).
  * IfcBridge with IfcBridgeParts: superstructure, 2 abutments, 3 piers.
  * Deck slabs, girders, pier columns, footings and abutment walls placed
    along the curved alignment.
  * A few deliberate data gaps so the "Checks" tab has something to find.
No external dependencies; standard library only.
"""
import math
import random
import sys

random.seed(7)
B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def guid():
    return "'" + random.choice("0123") + "".join(random.choice(B64) for _ in range(21)) + "'"


def R(v):
    s = f"{v:.6f}".rstrip("0")
    return s if not s.endswith("-0.") else "0."


def S(text):
    return "'" + str(text).replace("'", "''") + "'"


class Step:
    def __init__(self):
        self.lines = []
        self.n = 0

    def add(self, entity, *attrs):
        self.n += 1
        self.lines.append(f"#{self.n}={entity}({','.join(attrs)});")
        return f"#{self.n}"


# ------------------------------------------------------------------ alignment design (feet)
X0, Y0, DIR0 = 2_100_000.0, 650_000.0, math.radians(30)
HSEGS = [  # (type, r0, r1, length)  positive radius = curving left
    ("LINE", 0.0, 0.0, 400.0),
    ("CLOTHOID", 0.0, 1500.0, 150.0),
    ("CIRCULARARC", 1500.0, 1500.0, 500.0),
    ("CLOTHOID", 1500.0, 0.0, 150.0),
    ("LINE", 0.0, 0.0, 400.0),
]
VSEGS = [  # (type, d0, L, h0, g0, g1)
    ("CONSTANTGRADIENT", 0.0, 600.0, 800.0, 0.02, 0.02),
    ("PARABOLICARC", 600.0, 600.0, 812.0, 0.02, -0.015),
    ("CONSTANTGRADIENT", 1200.0, 400.0, 813.5, -0.015, -0.015),
]
START_STATION = 10000.0  # 100+00


def curvature(seg, u):
    _, r0, r1, L = seg
    k0 = 1 / r0 if r0 else 0.0
    k1 = 1 / r1 if r1 else 0.0
    return k0, k1, L


def integrate(seg, x, y, d, upto=None, n=2000):
    k0, k1, L = curvature(seg, 0)
    upto = L if upto is None else upto
    h = lambda u: d + k0 * u + (k1 - k0) * u * u / (2 * L)
    ds = upto / n
    for i in range(n):
        u0, u1 = i * ds, (i + 1) * ds
        um = (u0 + u1) / 2
        x += ds / 6 * (math.cos(h(u0)) + 4 * math.cos(h(um)) + math.cos(h(u1)))
        y += ds / 6 * (math.sin(h(u0)) + 4 * math.sin(h(um)) + math.sin(h(u1)))
    return x, y, h(upto)


def seg_starts():
    out, x, y, d = [], X0, Y0, DIR0
    for seg in HSEGS:
        out.append((x, y, d))
        x, y, d = integrate(seg, x, y, d)
    return out


STARTS = seg_starts()


def point_at(s):
    acc = 0.0
    for i, (seg, (x, y, d)) in enumerate(zip(HSEGS, STARTS)):
        if s <= acc + seg[3] or i == len(HSEGS) - 1:
            return integrate(seg, x, y, d, upto=max(0.0, s - acc), n=400)
        acc += seg[3]


def profile(s):
    for i, (t, d0, L, h0, g0, g1) in enumerate(VSEGS):
        if s <= d0 + L or i == len(VSEGS) - 1:
            u = s - d0
            return h0 + g0 * u + (g1 - g0) * u * u / (2 * L)


# ------------------------------------------------------------------ write IFC
def build(path):
    f = Step()
    origin3 = f.add("IFCCARTESIANPOINT", "(0.,0.,0.)")
    zdir = f.add("IFCDIRECTION", "(0.,0.,1.)")
    xdir = f.add("IFCDIRECTION", "(1.,0.,0.)")
    world = f.add("IFCAXIS2PLACEMENT3D", origin3, zdir, xdir)
    ctx = f.add("IFCGEOMETRICREPRESENTATIONCONTEXT", "$", S("Model"), "3", "1.E-05", world, "$")
    body = f.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", S("Body"), S("Model"), "*", "*", "*", "*", ctx, "$", ".MODEL_VIEW.", "$")

    metre = f.add("IFCSIUNIT", "*", ".LENGTHUNIT.", "$", ".METRE.")
    dims = f.add("IFCDIMENSIONALEXPONENTS", "1", "0", "0", "0", "0", "0", "0")
    mwu = f.add("IFCMEASUREWITHUNIT", "IFCLENGTHMEASURE(0.3048)", metre)
    foot = f.add("IFCCONVERSIONBASEDUNIT", dims, ".LENGTHUNIT.", S("FOOT"), mwu)
    rad = f.add("IFCSIUNIT", "*", ".PLANEANGLEUNIT.", "$", ".RADIAN.")
    units = f.add("IFCUNITASSIGNMENT", f"({foot},{rad})")

    project = f.add("IFCPROJECT", guid(), "$", S("Demo Bridge Project"), S("Fictional sample - not a real structure"),
                    "$", "$", "$", f"({ctx})", units)

    site_pl = f.add("IFCLOCALPLACEMENT", "$", world)
    site = f.add("IFCSITE", guid(), "$", S("Demo Site"), "$", "$", site_pl, "$", "$", ".ELEMENT.", "$", "$", "$", "$", "$")

    def placement(x, y, z, heading=0.0, rel=site_pl):
        loc = f.add("IFCCARTESIANPOINT", f"({R(x)},{R(y)},{R(z)})")
        ref_dir = f.add("IFCDIRECTION", f"({R(math.cos(heading))},{R(math.sin(heading))},0.)")
        ax = f.add("IFCAXIS2PLACEMENT3D", loc, zdir, ref_dir)
        return f.add("IFCLOCALPLACEMENT", rel, ax)

    bridge_pl = placement(*point_at(500)[:2], 0.0)
    bridge = f.add("IFCBRIDGE", guid(), "$", S("Demo Creek Bridge"), "$", "$", bridge_pl, "$",
                   S("Rte 99 over Demo Creek"), ".ELEMENT.", ".GIRDER.")

    styles = {}

    def style(name, r, g, b):
        col = f.add("IFCCOLOURRGB", "$", R(r), R(g), R(b))
        shading = f.add("IFCSURFACESTYLESHADING", col, "0.")
        styles[name] = f.add("IFCSURFACESTYLE", S(name), ".BOTH.", f"({shading})")

    style("Concrete", 0.78, 0.78, 0.74)
    style("Steel", 0.38, 0.47, 0.58)
    style("Footing", 0.62, 0.60, 0.55)

    def box_shape(xdim, ydim, depth, y_off, sty):
        p2 = f.add("IFCCARTESIANPOINT", f"(0.,{R(y_off)})")
        a2 = f.add("IFCAXIS2PLACEMENT2D", p2, "$")
        prof = f.add("IFCRECTANGLEPROFILEDEF", ".AREA.", "$", a2, R(xdim), R(ydim))
        pos = f.add("IFCAXIS2PLACEMENT3D", origin3, "$", "$")
        solid = f.add("IFCEXTRUDEDAREASOLID", prof, pos, zdir, R(depth))
        f.add("IFCSTYLEDITEM", solid, f"({styles[sty]})", "$")
        rep = f.add("IFCSHAPEREPRESENTATION", body, S("Body"), S("SweptSolid"), f"({solid})")
        return f.add("IFCPRODUCTDEFINITIONSHAPE", "$", "$", f"({rep})")

    def element(entity, name, s, zbase, xdim, ydim, depth, y_off=0.0, sty="Concrete", tag="$", pdt=".NOTDEFINED."):
        x, y, d = point_at(s)
        pl = placement(x, y, zbase, d)
        shape = box_shape(xdim, ydim, depth, y_off, sty)
        return f.add(entity, guid(), "$", S(name), "$", "$", pl, shape, tag, pdt)

    psets = []  # (element ids, pset name, [(prop, value-expr)])

    def pset(ids, name, props):
        psets.append((ids, name, props))

    parts = {}

    def part(name, pdt, s):
        x, y, _ = point_at(s)
        pl = placement(x, y, 0.0, 0.0)
        parts[name] = (f.add("IFCBRIDGEPART", guid(), "$", S(name), "$", "$", pl, "$", "$", ".ELEMENT.",
                             ".LONGITUDINAL.", f".{pdt}."), [])
        return parts[name][1]

    superstructure = part("Superstructure", "SUPERSTRUCTURE", 700)
    abut1 = part("Abutment 1", "ABUTMENT", 297)
    piers = [part(f"Pier {i + 1}", "PIER", s) for i, s in enumerate((500, 700, 900))]
    abut2 = part("Abutment 2", "ABUTMENT", 1103)

    GROUND = 762.0
    slabs, beams = [], []
    for j, s0 in enumerate(range(300, 1100, 50)):
        mid = s0 + 25
        top = profile(mid)
        sl = element("IFCSLAB", f"Deck pour {j + 1}", mid, top - 1.0, 50.4, 40.0, 1.0, pdt=".FLOOR.")
        superstructure.append(sl)
        slabs.append(sl)
        for g, off in enumerate((-15.0, -5.0, 5.0, 15.0)):
            b = element("IFCBEAM", f"Girder G{g + 1} - seg {j + 1}", mid, top - 1.0 - 4.5, 50.4, 1.5, 4.5,
                        y_off=off, sty="Steel", pdt=".GIRDER_SEGMENT.")
            superstructure.append(b)
            beams.append((b, g, j))

    columns = []
    for i, s in enumerate((500, 700, 900)):
        top = profile(s) - 5.5
        col = element("IFCCOLUMN", f"Pier {i + 1} wall", s, GROUND, 4.0, 30.0, top - GROUND, pdt=".COLUMN.")
        ftg = element("IFCFOOTING", f"Pier {i + 1} footing", s, GROUND - 3.0, 12.0, 36.0, 3.0, sty="Footing",
                      pdt=".PAD_FOOTING.")
        piers[i] += [col, ftg]
        columns.append(col)

    for lst, s, label in ((abut1, 297, "Abutment 1"), (abut2, 1103, "Abutment 2")):
        top = profile(s) - 5.5
        lst.append(element("IFCWALL", f"{label} stem", s, GROUND - 5.0, 6.0, 42.0, top - GROUND + 5.0,
                           pdt=".RETAININGWALL."))

    # Properties (with deliberate gaps for the Checks tab).
    pset([bridge], "DOT_BridgeInfo", [("StructureNumber", "IFCLABEL('000000012345678')"),
                                      ("FeatureIntersected", "IFCLABEL('DEMO CREEK')"),
                                      ("FacilityCarried", "IFCLABEL('RTE 99')")])
    for b, g, j in beams:
        if j != 6:  # segment 7 girders are missing their marks
            pset([b], "Pset_BeamCommon", [("Reference", f"IFCIDENTIFIER('G{g + 1}')"), ("LoadBearing", "IFCBOOLEAN(.T.)")])
    for k, sl in enumerate(slabs):
        pset([sl], "DOT_Concrete", [("ConcreteClass", "IFCLABEL('B')" if k in (3, 11) else "IFCLABEL('HPC')"),
                                    ("Fc_psi", "IFCREAL(5000.)")])
    pset(columns, "DOT_Concrete", [("ConcreteClass", "IFCLABEL('A')")])

    for ids, name, props in psets:
        pids = [f.add("IFCPROPERTYSINGLEVALUE", S(p), "$", v, "$") for p, v in props]
        ps = f.add("IFCPROPERTYSET", guid(), "$", S(name), "$", f"({','.join(pids)})")
        f.add("IFCRELDEFINESBYPROPERTIES", guid(), "$", "$", "$", f"({','.join(ids)})", ps)

    # Alignment (business logic only; the viewer computes the curve itself).
    al_pl = f.add("IFCLOCALPLACEMENT", site_pl, f.add("IFCAXIS2PLACEMENT3D", origin3, "$", "$"))
    alignment = f.add("IFCALIGNMENT", guid(), "$", S("CL Demo Rte"), "$", "$", al_pl, "$", ".NOTDEFINED.")
    horiz = f.add("IFCALIGNMENTHORIZONTAL", guid(), "$", S("Horizontal"), "$", "$", "$", "$")
    vert = f.add("IFCALIGNMENTVERTICAL", guid(), "$", S("Vertical"), "$", "$", "$", "$")

    hseg_ids = []
    for (t, r0, r1, L), (x, y, d) in zip(HSEGS, STARTS):
        sp = f.add("IFCCARTESIANPOINT", f"({R(x)},{R(y)})")
        p = f.add("IFCALIGNMENTHORIZONTALSEGMENT", "$", "$", sp, R(d), R(r0), R(r1), R(L), "$", f".{t}.")
        hseg_ids.append(f.add("IFCALIGNMENTSEGMENT", guid(), "$", "$", "$", "$", "$", "$", p))
    vseg_ids = []
    for t, d0, L, h0, g0, g1 in VSEGS:
        radius = R(L / (g1 - g0)) if t == "PARABOLICARC" else "$"
        p = f.add("IFCALIGNMENTVERTICALSEGMENT", "$", "$", R(d0), R(L), R(h0), R(g0), R(g1), radius, f".{t}.")
        vseg_ids.append(f.add("IFCALIGNMENTSEGMENT", guid(), "$", "$", "$", "$", "$", "$", p))

    referent = f.add("IFCREFERENT", guid(), "$", S("100+00"), "$", "$", "$", "$", ".STATION.")
    sta_prop = f.add("IFCPROPERTYSINGLEVALUE", S("Station"), "$", f"IFCLENGTHMEASURE({R(START_STATION)})", "$")
    sta_ps = f.add("IFCPROPERTYSET", guid(), "$", S("Pset_Stationing"), "$", f"({sta_prop})")
    f.add("IFCRELDEFINESBYPROPERTIES", guid(), "$", "$", "$", f"({referent})", sta_ps)

    f.add("IFCRELNESTS", guid(), "$", "$", "$", alignment, f"({horiz},{vert})")
    f.add("IFCRELNESTS", guid(), "$", "$", "$", alignment, f"({referent})")
    f.add("IFCRELNESTS", guid(), "$", "$", "$", horiz, f"({','.join(hseg_ids)})")
    f.add("IFCRELNESTS", guid(), "$", "$", "$", vert, f"({','.join(vseg_ids)})")

    # Spatial structure.
    f.add("IFCRELAGGREGATES", guid(), "$", "$", "$", project, f"({site},{alignment})")
    f.add("IFCRELAGGREGATES", guid(), "$", "$", "$", site, f"({bridge})")
    part_ids = [p[0] for p in parts.values()]
    f.add("IFCRELAGGREGATES", guid(), "$", "$", "$", bridge, f"({','.join(part_ids)})")
    for pid, elems in parts.values():
        if elems:
            f.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", guid(), "$", "$", "$", f"({','.join(elems)})", pid)

    header = [
        "ISO-10303-21;",
        "HEADER;",
        "FILE_DESCRIPTION(('ViewDefinition [Alignment-basedReferenceView]'),'2;1');",
        "FILE_NAME('demo-bridge.ifc','2026-11-19T00:00:00',('Bridge IFC Viewer'),(''),'make_demo_ifc.py','make_demo_ifc.py','');",
        "FILE_SCHEMA(('IFC4X3_ADD2'));",
        "ENDSEC;",
        "DATA;",
    ]
    with open(path, "w", newline="\n") as fh:
        fh.write("\n".join(header + f.lines + ["ENDSEC;", "END-ISO-10303-21;", ""]))
    return f.n


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "demo-bridge.ifc"
    n = build(out)
    print(f"Wrote {out} ({n} entities). Alignment end: {point_at(1600)[:2]}, start station {START_STATION}.")
