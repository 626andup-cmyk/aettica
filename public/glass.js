/**
 * Liquid glass: real refraction for a theme's glass.
 *
 * A theme's glass is usually a blur (`backdrop-filter: blur(...)`): frosted,
 * but flat. Real glass is clear, and its thick, rounded edge works like a
 * lens: whatever is behind it bends as it nears the rim, and white light
 * splits into a faint rainbow there. This file does that, in browsers that
 * can (Chrome and other Chromium browsers, including on Android).
 *
 * ## How it works
 *
 * An SVG filter can move pixels around: `feDisplacementMap` shifts each
 * pixel of an image by an amount read from a second image, the
 * *displacement map* (red = sideways, green = up and down, mid-grey = stay
 * put). Used as a `backdrop-filter`, it shifts what's *behind* an element.
 *
 * So each glass element gets a displacement map the size of the element:
 * grey in the middle (flat glass, no bending), and around the rim, arrows
 * pointing inward, strongest at the very edge, like the curved edge of a
 * lens. Each colour channel is shifted by a slightly different amount,
 * which splits the light into a rainbow fringe (dispersion).
 *
 * ## For theme authors
 *
 * An element becomes lensed glass when the theme gives it `--lens: 1`.
 * (`--lens` doesn't inherit, so its children aren't lensed too; see the
 * `@property` rule in style.css.) These tune it, and can be set anywhere,
 * for example on `:root`, or by a slider:
 *
 *   --lens-depth       how far the rim bends the background, in px (default 24)
 *   --lens-bevel       how wide the curved rim is at least, in px (default 18;
 *                      a deeper lens gets a wider one, see RIM)
 *   --lens-dispersion  how much the colours split at the rim, 0 to 1 (default 0.3)
 *   --lens-frost       a blur behind the glass, in px (default 0: clear)
 *   --lens-saturate    colour boost through the glass (default 1.2)
 *
 * The theme's own `backdrop-filter` stays as the fallback: in other
 * browsers, and in Lite mode, it's used instead.
 *
 * While an element is lensed it has the class `lensed`. **A lensed element
 * must not reach outside its own box**: no outer box-shadow, on it or
 * anything inside it. Chrome versions disagree about where a backdrop
 * filter goes when an element's shadow spills over its edges (some move it
 * by the shadow's size, some don't), so the lens would land in the wrong
 * place on some phones. Themes drop their outer shadows under `.lensed`,
 * and keep them for other browsers and Lite mode.
 *
 * ## Keeping it fast
 *
 * - A map isn't drawn per element. It's put together inside the filter
 *   from nine pieces, like a nine-slice image: four corners, four edge
 *   strips stretched along the sides, and flat grey in the middle. The
 *   pieces only depend on the corner radius and the lens's shape, so every
 *   bubble with the same corners shares them, whatever its size.
 * - When an element changes size (a message growing as your partner
 *   writes), only the pieces' positions change: no drawing, no new images.
 * - Without rainbow edges the filter is one shift instead of three, and the
 *   colour boost is folded into the channel split, so the browser does as
 *   few full passes over the glass as possible.
 * - New elements are looked for only in what was just added to the page,
 *   and nothing runs while you scroll.
 *
 * Chrome also doesn't give a lens the full picture of a layer with a
 * `transform`, so themes shouldn't move their background layers with one.
 *
 * This file also provides `#aettica-goo`, a "gooey" filter that makes
 * shapes merge like droplets when they touch (used for the typing dots in
 * liquid themes), in every browser.
 */

"use strict";

const Glass = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** Elements a theme might make glass. Only these are checked for `--lens`. */
  const CANDIDATES = [
    ".surface",
    ".message",
    ".button",
    ".icon-button",
    ".channel-indicator",
    ".theme-card",
    ".inbox-card",
    ".attach-chip",
    ".message-comments",
    ".posting-as",
    ".composer-input",
    ".profile-row",
    ".notebook-entry",
  ].join(",");

  /** Chromium can use an SVG filter as a backdrop filter; Safari and Firefox can't (yet). */
  const supported =
    /Chrome\/\d+/.test(navigator.userAgent) && CSS.supports("backdrop-filter", "url(#aettica-lens)");

  /**
   * The lens's proportions. MAX_BEND sets how much the very edge
   * magnifies: 1 / (1 - MAX_BEND), about 3.3 times (any more and shapes
   * behind smear into flat streaks there). RIM is how wide the curved rim
   * is, at least, for how far it bends: narrower, and the rim couldn't
   * blend smoothly into the flat middle, leaving a visible seam. So a
   * deeper lens gets a wider rim, as far as the element's size allows,
   * and only then is its depth limited.
   */
  const MAX_BEND = 0.7;
  const RIM = 2.2;

  /** At most this many sets of map pieces are kept (one per corner shape). */
  const MAX_PIECE_SETS = 40;

  let enabled = false;
  let defs = null;
  let nextId = 0;

  /**
   * Glass elements being watched → their lens:
   * `{ size, filter, nodes, shape }`. `size` comes from the resize
   * observer; `filter` is the element's own <filter> once it has a size.
   */
  const watched = new Map();
  /** Map pieces by corner shape (see `piecesFor`). */
  const pieceSets = new Map();

  const resizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const lens = watched.get(entry.target);
      if (!lens) continue;
      // The border box, before any transform (a pressed bubble shrinks a
      // little, but its lens shouldn't change).
      const box = entry.borderBoxSize?.[0];
      lens.size = box
        ? { width: box.inlineSize, height: box.blockSize }
        : { width: entry.target.offsetWidth, height: entry.target.offsetHeight };
      render(entry.target, lens);
    }
  });

  // Only what's added to the page needs looking at. (A message growing as
  // your partner writes changes only text, which is skipped at once.)
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === 1) queueScan(node);
      for (const node of record.removedNodes) if (node.nodeType === 1) queueCleanup();
    }
  });

  // ------------------------------------------------------------- setup

  /** The hidden <svg> that holds the filters, with the goo filter in it. */
  function ensureDefs() {
    if (defs) return defs;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    defs = document.createElementNS(SVG_NS, "defs");
    // Goo: blur shapes together, then sharpen their edges again, so shapes
    // that are close merge like drops of water.
    defs.innerHTML = `
      <filter id="aettica-goo" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
        <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="goo"/>
        <feComposite in="SourceGraphic" in2="goo" operator="atop"/>
      </filter>`;
    svg.append(defs);
    document.body.append(svg);
    return defs;
  }

  /**
   * Turn lensing on or off (off in Lite mode, or where it isn't supported).
   * Returns whether it's on.
   */
  function setEnabled(on) {
    ensureDefs();
    const next = Boolean(on) && supported;
    if (next === enabled) return enabled;
    enabled = next;
    if (enabled) {
      mutations.observe(document.body, { childList: true, subtree: true });
      queueScan(document.body);
    } else {
      mutations.disconnect();
      for (const element of [...watched.keys()]) forget(element);
    }
    return enabled;
  }

  /** Look again at every element, e.g. after the theme or a slider changed. */
  function refresh() {
    if (enabled) queueScan(document.body);
  }

  // Work is batched into the next frame.
  const scanRoots = new Set();
  let cleanupQueued = false;
  let frameQueued = false;

  function queueScan(root) {
    scanRoots.add(root);
    queueFrame();
  }

  function queueCleanup() {
    cleanupQueued = true;
    queueFrame();
  }

  function queueFrame() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      if (!enabled) return;
      if (cleanupQueued) {
        cleanupQueued = false;
        for (const element of [...watched.keys()]) if (!element.isConnected) forget(element);
      }
      const roots = [...scanRoots];
      scanRoots.clear();
      // Scanning the whole page covers everything else.
      if (roots.includes(document.body)) scan(document.body, true);
      else for (const root of roots) if (root.isConnected) scan(root, false);
    });
  }

  /**
   * Lens every glass element in `root`. A full scan (of the whole page)
   * also re-reads every lens's settings, and stops lensing whatever isn't
   * glass any more.
   */
  function scan(root, full) {
    const blocked = new Map();
    const found = [...root.querySelectorAll(CANDIDATES)];
    if (root.matches?.(CANDIDATES)) found.push(root);
    const seen = new Set();
    for (const element of found) {
      if (!isGlass(element, blocked)) continue;
      seen.add(element);
      const lens = watched.get(element);
      if (!lens) {
        // The observer reports its size straight away, and then renders it.
        watched.set(element, { size: null, filter: null, nodes: null, shape: "" });
        resizes.observe(element);
      } else if (full) {
        render(element, lens);
      }
    }
    if (full) {
      for (const element of [...watched.keys()]) if (!seen.has(element)) forget(element);
    }
  }

  /**
   * Whether the theme makes an element lensed glass. Not inside another
   * glass panel: an element with a backdrop filter only lets the elements
   * in it see *its* own fill, not the page behind (it's their "backdrop
   * root"), so a lens there would only bend a faint tint. Those keep the
   * theme's own backdrop filter, and cost nothing. (`blocked` remembers
   * the answer for each parent during one scan.)
   */
  function isGlass(element, blocked) {
    if (!(parseFloat(getComputedStyle(element).getPropertyValue("--lens")) > 0)) return false;
    return !insideGlass(element.parentElement, blocked);
  }

  function insideGlass(parent, blocked) {
    if (!parent || parent === document.body || parent === document.documentElement) return false;
    if (blocked.has(parent)) return blocked.get(parent);
    const style = getComputedStyle(parent);
    const answer =
      style.backdropFilter !== "none" || style.filter !== "none" || insideGlass(parent.parentElement, blocked);
    blocked.set(parent, answer);
    return answer;
  }

  // ---------------------------------------------------------- applying

  /** Give an element the lens for its current size and settings. */
  function render(element, lens) {
    if (!enabled || !element.isConnected) return forget(element);
    const size = lens.size;
    // Too small to see, or not laid out (a closed dialog): the observer
    // calls again when it has a size.
    if (!size || size.width < 12 || size.height < 12) return unlens(element, lens);

    const style = getComputedStyle(element);
    const number = (name, fallback) => {
      const value = parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const { width, height } = size;
    const half = Math.min(width, height) / 2;
    const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, half);
    // A deeper lens needs a wider rim (see RIM).
    const wantedDepth = Math.max(0, number("--lens-depth", 24));
    const bevel = Math.max(1, Math.round(Math.min(half, Math.max(2, number("--lens-bevel", 18), wantedDepth * RIM))));
    const settings = {
      radius: Math.round(radius),
      bevel,
      depth: Math.round(Math.min(wantedDepth, bevel / RIM)),
      dispersion: Math.min(1, Math.max(0, number("--lens-dispersion", 0.3))),
      frost: Math.max(0, number("--lens-frost", 0)),
      saturate: Math.max(0, number("--lens-saturate", 1.2)),
    };

    // A new shape or new settings rebuild the filter; a new size only moves its pieces.
    const shape = Object.values(settings).join("|");
    if (!lens.filter) {
      lens.filter = document.createElementNS(SVG_NS, "filter");
      lens.filter.id = `aettica-lens-${nextId++}`;
      lens.filter.setAttribute("x", "0");
      lens.filter.setAttribute("y", "0");
      lens.filter.setAttribute("filterUnits", "userSpaceOnUse");
      lens.filter.setAttribute("color-interpolation-filters", "sRGB");
      ensureDefs().append(lens.filter);
    }
    if (lens.shape !== shape) {
      lens.shape = shape;
      lens.nodes = buildFilter(lens.filter, settings);
    }
    place(lens, width, height);

    if (!element.classList.contains("lensed")) {
      const filter = `url(#${lens.filter.id})`;
      element.style.setProperty("backdrop-filter", filter);
      element.style.setProperty("-webkit-backdrop-filter", filter);
      element.classList.add("lensed");
    }
  }

  /** Stop lensing an element (for now): its theme's own backdrop filter applies again. */
  function unlens(element, lens) {
    if (!element.classList.contains("lensed")) return;
    element.style.removeProperty("backdrop-filter");
    element.style.removeProperty("-webkit-backdrop-filter");
    element.classList.remove("lensed");
    lens.filter?.remove();
    lens.filter = null;
    lens.shape = "";
  }

  /** Stop lensing and watching an element. */
  function forget(element) {
    const lens = watched.get(element);
    if (!lens) return;
    unlens(element, lens);
    lens.filter?.remove();
    resizes.unobserve(element);
    watched.delete(element);
  }

  // ------------------------------------------------------------ filters

  /**
   * Fill a lens's <filter>: assemble the displacement map from its nine
   * pieces, blur the backdrop (if frosted), shift it by the map, and boost
   * its colour. Returns the pieces' nodes, for `place` to position.
   *
   * With rainbow edges, the backdrop is shifted three times, a little
   * differently for red, green and blue, and the channels are put back
   * together. That takes care where the backdrop is see-through (the edge
   * of the page, or a translucent parent): blending three see-through
   * images adds up their opacity, which turns them grey. So each channel
   * is made opaque first, and the green pass's own opacity is put back at
   * the end (`operator="in"`). The colour boost is part of each channel's
   * matrix, rather than a pass of its own.
   */
  function buildFilter(filter, s) {
    const pieces = piecesFor(s.radius, s.bevel, s.depth);
    // The map's arrows are at most half its range (0.5 of 1), so the scale
    // is twice the wanted shift. Red bends a little less, blue a little
    // more: that's what splits the colours.
    const scale = s.depth * 2;
    const frost =
      s.frost > 0
        ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${s.frost}" edgeMode="duplicate" result="source"/>`
        : `<feOffset in="SourceGraphic" result="source"/>`;
    const shift = (amount, result) =>
      `<feDisplacementMap in="source" in2="map" scale="${(scale * amount).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${result}"/>`;

    let glass;
    if (s.dispersion > 0) {
      const spread = s.dispersion * 0.35;
      const m = saturation(s.saturate);
      // Keep one row of the colour boost, for one channel, and make it opaque.
      const only = (row) =>
        [0, 1, 2].map((r) => (r === row ? `${m[r].join(" ")} 0 0` : "0 0 0 0 0")).join("  ") + "  0 0 0 0 1";
      glass = `
        ${shift(1 - spread, "red-shifted")}
        <feColorMatrix in="red-shifted" type="matrix" values="${only(0)}" result="red"/>
        ${shift(1, "green-shifted")}
        <feColorMatrix in="green-shifted" type="matrix" values="${only(1)}" result="green"/>
        ${shift(1 + spread, "blue-shifted")}
        <feColorMatrix in="blue-shifted" type="matrix" values="${only(2)}" result="blue"/>
        <feBlend in="red" in2="green" mode="screen" result="red-green"/>
        <feBlend in="red-green" in2="blue" mode="screen" result="opaque"/>
        <feComposite in="opaque" in2="green-shifted" operator="in"/>`;
    } else {
      glass = `
        ${shift(1, "shifted")}
        <feColorMatrix in="shifted" type="saturate" values="${s.saturate}"/>`;
    }

    const image = (name) =>
      `<feImage data-piece="${name}" href="${pieces[name]}" preserveAspectRatio="none" result="${name}"/>`;
    filter.innerHTML = `
      <feFlood flood-color="rgb(128,128,128)" result="flat"/>
      ${["top", "bottom", "left", "right", "topLeft", "topRight", "bottomLeft", "bottomRight"].map(image).join("")}
      <feMerge result="map">
        <feMergeNode in="flat"/><feMergeNode in="top"/><feMergeNode in="bottom"/><feMergeNode in="left"/><feMergeNode in="right"/>
        <feMergeNode in="topLeft"/><feMergeNode in="topRight"/><feMergeNode in="bottomLeft"/><feMergeNode in="bottomRight"/>
      </feMerge>
      ${frost}
      ${glass}`;
    const nodes = { corner: pieces.corner };
    for (const node of filter.querySelectorAll("feImage")) nodes[node.dataset.piece] = node;
    return nodes;
  }

  /**
   * Put a lens's pieces in place for the element's size: corners in the
   * corners, the edge strips stretched along the sides between them, and
   * the filter covering the whole element. Sizes can be fractions of a
   * pixel, so the lens reaches the very edge.
   */
  function place(lens, width, height) {
    const { nodes } = lens;
    const c = nodes.corner;
    const across = Math.max(0, width - 2 * c);
    const down = Math.max(0, height - 2 * c);
    const set = (node, x, y, w, h) => {
      // An empty strip (a bubble exactly as tall as its two corners) is left out.
      if (w <= 0 || h <= 0) {
        node.setAttribute("width", "0");
        node.setAttribute("height", "0");
        return;
      }
      node.setAttribute("x", x);
      node.setAttribute("y", y);
      node.setAttribute("width", w);
      node.setAttribute("height", h);
    };
    lens.filter.setAttribute("width", width);
    lens.filter.setAttribute("height", height);
    set(nodes.topLeft, 0, 0, c, c);
    set(nodes.topRight, width - c, 0, c, c);
    set(nodes.bottomLeft, 0, height - c, c, c);
    set(nodes.bottomRight, width - c, height - c, c, c);
    set(nodes.top, c, 0, across, c);
    set(nodes.bottom, c, height - c, across, c);
    set(nodes.left, 0, c, c, down);
    set(nodes.right, width - c, c, c, down);
  }

  /** The colour boost (saturation) as a 3×3 matrix, from the SVG spec. */
  function saturation(s) {
    const f = (n) => Number(n.toFixed(4));
    return [
      [f(0.213 + 0.787 * s), f(0.715 - 0.715 * s), f(0.072 - 0.072 * s)],
      [f(0.213 - 0.213 * s), f(0.715 + 0.285 * s), f(0.072 - 0.072 * s)],
      [f(0.213 - 0.213 * s), f(0.715 - 0.715 * s), f(0.072 + 0.928 * s)],
    ];
  }

  // ------------------------------------------------------------- pieces

  /**
   * The nine-slice pieces of the displacement map for this corner shape,
   * as PNG data URLs, made once and shared by every lens with the same
   * corners, whatever its size.
   *
   * They're cut from the map of a small square with the same corners (see
   * `drawMap`): each corner is `c × c`, where `c` covers both the rounded
   * corner and the rim (the part that depends on both directions). Along a
   * straight side, the map only changes going inward, so a strip one pixel
   * long can be stretched along the whole side. The middle is flat grey,
   * which the filter fills in itself.
   */
  function piecesFor(radius, bevel, depth) {
    const key = `${radius}|${bevel}|${depth}`;
    const known = pieceSets.get(key);
    if (known) return known;

    const c = Math.max(1, Math.ceil(Math.max(radius, bevel)));
    // Two pixels wider than two corners, so the middle row and column are
    // on straight sides.
    const size = 2 * c + 2;
    const map = drawMap(size, radius, bevel, depth);
    const cut = (x, y, w, h) => {
      const piece = document.createElement("canvas");
      piece.width = w;
      piece.height = h;
      piece.getContext("2d").drawImage(map, x, y, w, h, 0, 0, w, h);
      return piece.toDataURL("image/png");
    };
    const pieces = {
      corner: c,
      topLeft: cut(0, 0, c, c),
      topRight: cut(size - c, 0, c, c),
      bottomLeft: cut(0, size - c, c, c),
      bottomRight: cut(size - c, size - c, c, c),
      top: cut(c + 1, 0, 1, c),
      bottom: cut(c + 1, size - c, 1, c),
      left: cut(0, c + 1, c, 1),
      right: cut(size - c, c + 1, c, 1),
    };
    pieceSets.set(key, pieces);
    // Forget the oldest set, if there are many (lenses already built keep theirs).
    if (pieceSets.size > MAX_PIECE_SETS) pieceSets.delete(pieceSets.keys().next().value);
    return pieces;
  }

  /**
   * Draw the displacement map of a `size × size` square with rounded
   * corners, on a canvas.
   *
   * For each pixel within `bevel` of the edge, the arrow points inward
   * (along the edge's normal, so corners curve too). Red holds the
   * sideways part, green the vertical part, both centred on 128 (no shift).
   *
   * How far each pixel looks inward is the lens's shape. A pixel `d` in
   * from the edge shows what's at `d + depth · u^k`, where `u` is how close
   * it is to the edge (1 at the edge, 0 where the rim ends) and
   * `k = MAX_BEND · bevel / depth` (at least MAX_BEND · RIM, about 1.5).
   * That's chosen so that:
   *
   * - at the very edge it shows what's `depth` further in, and the rim
   *   magnifies more and more towards the edge (up to about 3.3 times),
   *   like the curved edge of a thick lens;
   * - it never looks back outward again, so the picture never folds over
   *   itself;
   * - it meets the flat middle smoothly (as `k` is more than 1), with no
   *   visible seam.
   */
  function drawMap(size, radius, bevel, depth) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const image = context.createImageData(size, size);
    // Fill everything with "no shift" at once (RGBA 128, 128, 128, 255).
    new Uint32Array(image.data.buffer).fill(0xff808080);

    const centre = size / 2;
    const straight = centre - radius;
    const power = depth > 0 ? (MAX_BEND * bevel) / depth : 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Signed distance to a rounded rectangle (negative inside).
        const px = x + 0.5 - centre;
        const py = y + 0.5 - centre;
        const qx = Math.abs(px) - straight;
        const qy = Math.abs(py) - straight;
        const ox = Math.max(qx, 0);
        const oy = Math.max(qy, 0);
        const outside = Math.hypot(ox, oy);
        const inside = -(outside + Math.min(Math.max(qx, qy), 0) - radius);
        if (inside < 0 || inside >= bevel) continue;
        // The outward normal: towards the nearest corner's centre, or straight out from a side.
        let nx;
        let ny;
        if (qx > 0 && qy > 0) {
          nx = (ox / outside) * Math.sign(px);
          ny = (oy / outside) * Math.sign(py);
        } else if (qx > qy) {
          nx = Math.sign(px);
          ny = 0;
        } else {
          nx = 0;
          ny = Math.sign(py);
        }
        const strength = (1 - inside / bevel) ** power;
        const i = (y * size + x) * 4;
        // Inward: the opposite of the normal.
        image.data[i] = Math.round(128 - nx * strength * 127);
        image.data[i + 1] = Math.round(128 - ny * strength * 127);
      }
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  return { setEnabled, refresh, supported, isEnabled: () => enabled };
})();
