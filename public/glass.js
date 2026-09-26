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
 * So for each glass element, this draws a displacement map the size of the
 * element: grey in the middle (flat glass, no bending), and around the rim,
 * arrows pointing inward, strongest at the very edge, like the curved edge
 * of a lens. Each colour channel is shifted by a slightly different amount,
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
 * ## Keeping it fast
 *
 * - A lens is made once per size and settings, and shared by every element
 *   of that size (most bubbles in a channel are the same width).
 * - Only the rim of a map is computed; the middle is filled in one go.
 *   Large maps are drawn at half resolution: the rim is smooth, so nothing
 *   is lost.
 * - Nothing runs while you scroll: the filters are static, and the browser
 *   applies them on the GPU. Work only happens when elements appear or
 *   change size (or are hovered, pressed or focused, which can change
 *   their shadow; see `shadowReach`).
 *
 * Two quirks of Chrome's are worked around here or in the themes: it shifts
 * a lensed element's backdrop by how far its shadows reach (see
 * `shadowReach`), and it doesn't give a lens the full picture of a layer
 * with a `transform`, so themes shouldn't move their background layers
 * with one.
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

  /** At most this many lenses are kept; the least recently used go first. */
  const MAX_LENSES = 120;

  let enabled = false;
  let defs = null;
  /** Lens key → { id, node } (a Map keeps insertion order, used for least-recently-used). */
  const lenses = new Map();
  /** Elements currently lensed → their lens key. */
  const lensed = new Map();
  /** Glass elements with no size yet (in a closed dialog), watched until they have one. */
  const waiting = new Set();
  let scanQueued = false;

  const resizes = new ResizeObserver((entries) => {
    for (const entry of entries) apply(entry.target);
  });
  const mutations = new MutationObserver(queueScan);
  /** Lensed elements to look at again on the next frame (see `recheck`). */
  const pending = new Set();

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
      for (const type of RECHECK_ON) document.addEventListener(type, recheck, true);
      queueScan();
    } else {
      for (const type of RECHECK_ON) document.removeEventListener(type, recheck, true);
      mutations.disconnect();
      for (const element of [...lensed.keys()]) clear(element);
    }
    return enabled;
  }

  /** Look again at every element, e.g. after the theme or a slider changed. */
  function refresh() {
    if (enabled) queueScan();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  /**
   * Events after which a lensed element may have a different shadow or
   * outline (hovered, pressed, focused), which moves its lens (see
   * `shadowReach`), so it's looked at again.
   */
  const RECHECK_ON = ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout", "transitionend"];

  function recheck(event) {
    for (let element = event.target; element instanceof Element; element = element.parentElement) {
      if (lensed.has(element)) pending.add(element);
    }
    if (pending.size === 0) return;
    requestAnimationFrame(() => {
      for (const element of pending) apply(element);
      pending.clear();
    });
  }

  /** Lens every candidate the theme marks as glass, and stop lensing the rest. */
  function scan() {
    if (!enabled) return;
    const seen = new Set();
    for (const element of document.querySelectorAll(CANDIDATES)) {
      if (isGlass(element)) {
        seen.add(element);
        apply(element);
      }
    }
    for (const element of [...lensed.keys(), ...waiting]) {
      if (!seen.has(element)) clear(element);
    }
  }

  /**
   * Whether the theme makes an element lensed glass. Not inside another
   * glass panel: an element with a backdrop filter only lets the elements
   * in it see *its* own fill, not the page behind (it's their "backdrop
   * root"), so a lens there would only bend a faint tint. Those keep the
   * theme's own backdrop filter, and cost nothing.
   */
  function isGlass(element) {
    if (!(parseFloat(getComputedStyle(element).getPropertyValue("--lens")) > 0)) return false;
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.backdropFilter !== "none" || style.filter !== "none") return false;
    }
    return true;
  }

  // ---------------------------------------------------------- applying

  /** Give an element the lens for its current size and settings. */
  function apply(element) {
    if (!enabled || !element.isConnected) return clear(element);
    const width = Math.round(element.offsetWidth);
    const height = Math.round(element.offsetHeight);
    // Too small to see, or not laid out (a closed dialog): look again when
    // its size changes.
    if (width < 12 || height < 12) {
      if (!lensed.has(element) && !waiting.has(element)) {
        waiting.add(element);
        resizes.observe(element);
      }
      return;
    }
    waiting.delete(element);

    const style = getComputedStyle(element);
    const number = (name, fallback) => {
      const value = parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const half = Math.min(width, height) / 2;
    const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, half);
    // A deeper lens needs a wider rim (see RIM).
    const wantedDepth = Math.max(0, number("--lens-depth", 24));
    const bevel = Math.min(half, Math.max(2, number("--lens-bevel", 18), wantedDepth * RIM));
    const [left, top] = shadowReach(element, style);
    const settings = {
      width,
      height,
      left,
      top,
      radius: Math.round(radius),
      bevel: Math.round(bevel),
      depth: Math.round(Math.min(wantedDepth, bevel / RIM)),
      dispersion: Math.min(1, Math.max(0, number("--lens-dispersion", 0.3))),
      frost: Math.max(0, number("--lens-frost", 0)),
      saturate: Math.max(0, number("--lens-saturate", 1.2)),
    };
    const key = Object.values(settings).join("|");
    if (lensed.get(element) === key) return;

    const lens = lensFor(key, settings);
    const filter = `url(#${lens.id})`;
    element.style.setProperty("backdrop-filter", filter);
    element.style.setProperty("-webkit-backdrop-filter", filter);
    if (!lensed.has(element)) resizes.observe(element);
    lensed.set(element, key);
  }

  /**
   * How far an element's shadows and outline reach past its left and top
   * edges, in px.
   *
   * Chrome places a backdrop filter by the element's box *including* its
   * outer shadows and outline, but then draws the result from the
   * element's own top-left corner. So when a shadow reaches 30px past the
   * top edge, the whole lens lands 30px too low. The lens is drawn that
   * much higher and further left to make up for it.
   *
   * A shadow reaches (blur × 1.5 + spread − offset) past an edge: Chrome
   * blurs to three standard deviations, and the standard deviation is half
   * the blur. Inset shadows stay inside, so they don't count.
   *
   * But only as far as it can be seen: a scrolling (or overflow: hidden)
   * ancestor cuts it off at the start of its content, so a bubble 12px
   * inside the message list reaches at most 12px to the left. (That's
   * measured from the start of the scrolled content, not what's showing,
   * so it doesn't change as you scroll.)
   */
  function shadowReach(element, style) {
    let left = 0;
    let top = 0;
    // Shadows are separated by commas, but so are the numbers in rgb(...).
    for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
      if (/\binset\b/.test(shadow)) continue;
      const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      const reach = blur * 1.5 + spread;
      left = Math.max(left, reach - x);
      top = Math.max(top, reach - y);
    }
    if (style.outlineStyle !== "none") {
      const outline = (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0);
      left = Math.max(left, outline);
      top = Math.max(top, outline);
    }
    if (left <= 0 && top <= 0) return [0, 0];
    // Cut off by the page's edge, and by clipping ancestors.
    const box = element.getBoundingClientRect();
    left = Math.min(left, box.left + window.scrollX);
    top = Math.min(top, box.top + window.scrollY);
    for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const clip = getComputedStyle(parent);
      if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
      const outer = parent.getBoundingClientRect();
      left = Math.min(left, box.left - (outer.left + parent.clientLeft - parent.scrollLeft));
      top = Math.min(top, box.top - (outer.top + parent.clientTop - parent.scrollTop));
    }
    return [Math.max(0, Math.round(left)), Math.max(0, Math.round(top))];
  }

  /** Stop lensing an element: its theme's own backdrop filter applies again. */
  function clear(element) {
    if (waiting.delete(element)) resizes.unobserve(element);
    if (!lensed.has(element)) return;
    element.style.removeProperty("backdrop-filter");
    element.style.removeProperty("-webkit-backdrop-filter");
    resizes.unobserve(element);
    lensed.delete(element);
  }

  // ------------------------------------------------------------ lenses

  let nextId = 0;

  /** The lens filter for these settings: made once, then reused. */
  function lensFor(key, settings) {
    const existing = lenses.get(key);
    if (existing) {
      // Most recently used goes to the end.
      lenses.delete(key);
      lenses.set(key, existing);
      return existing;
    }
    const id = `aettica-lens-${nextId++}`;
    const node = buildFilter(id, settings);
    ensureDefs().append(node);
    const lens = { id, node };
    lenses.set(key, lens);
    // Forget the least recently used lens that nothing is using.
    if (lenses.size > MAX_LENSES) {
      const inUse = new Set(lensed.values());
      for (const [oldKey, old] of lenses) {
        if (!inUse.has(oldKey)) {
          old.node.remove();
          lenses.delete(oldKey);
          break;
        }
      }
    }
    return lens;
  }

  /**
   * The SVG filter: blur (if frosted), then shift the backdrop by the
   * displacement map three times, a little differently for red, green and
   * blue, and put the channels back together.
   *
   * Putting them back together takes care where the backdrop is see-through
   * (the edge of the page, or a translucent parent): blending three
   * see-through images adds up their opacity, which turns them grey. So
   * each channel is made opaque first, and the green pass's own opacity is
   * put back at the end (`operator="in"`).
   */
  function buildFilter(id, s) {
    const map = displacementMap(s);
    // The map's arrows are at most half its range (0.5 of 1), so the scale
    // is twice the wanted shift. Red bends a little less, blue a little
    // more: that's what splits the colours.
    const scale = s.depth * 2;
    const spread = s.dispersion * 0.35;
    const channel = (name, amount, matrix) => `
      <feDisplacementMap in="source" in2="map" scale="${(scale * amount).toFixed(2)}"
        xChannelSelector="R" yChannelSelector="G" result="${name}-shifted"/>
      <feColorMatrix in="${name}-shifted" type="matrix" values="${matrix} 0 0 0 0 1" result="${name}"/>`;
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.id = id;
    // Up and to the left by the shadows' reach (see `shadowReach`).
    filter.setAttribute("x", String(-s.left));
    filter.setAttribute("y", String(-s.top));
    filter.setAttribute("width", String(s.width));
    filter.setAttribute("height", String(s.height));
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    // Frost blurs the backdrop first; clear glass uses it as it is.
    const frost = s.frost > 0
      ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${s.frost}" edgeMode="duplicate" result="source"/>`
      : `<feOffset in="SourceGraphic" result="source"/>`;
    filter.innerHTML = `
      <feImage href="${map}" x="${-s.left}" y="${-s.top}" width="${s.width}" height="${s.height}" preserveAspectRatio="none" result="map"/>
      ${frost}
      ${channel("red", 1 - spread, "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0 ")}
      ${channel("green", 1, "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0 ")}
      ${channel("blue", 1 + spread, "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0 ")}
      <feBlend in="red" in2="green" mode="screen" result="red-green"/>
      <feBlend in="red-green" in2="blue" mode="screen" result="opaque"/>
      <feComposite in="opaque" in2="green-shifted" operator="in" result="glass"/>
      <feColorMatrix in="glass" type="saturate" values="${s.saturate}"/>`;
    return filter;
  }

  /**
   * Draw the displacement map for a rounded rectangle, as a PNG data URL.
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
  function displacementMap({ width, height, radius, bevel, depth }) {
    // Big maps at half resolution: the rim is smooth, and it's a quarter the work.
    const scale = width * height > 40_000 ? 0.5 : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const r = radius * scale;
    const b = Math.max(1, bevel * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    const image = context.createImageData(w, h);
    // Fill everything with "no shift" at once (RGBA 128, 128, 128, 255).
    new Uint32Array(image.data.buffer).fill(0xff808080);

    const cx = w / 2;
    const cy = h / 2;
    const hx = w / 2 - r;
    const hy = h / 2 - r;
    const band = Math.ceil(b) + 1;
    const power = depth > 0 ? (MAX_BEND * bevel) / depth : 1;
    const pixel = (x, y) => {
      // Signed distance to a rounded rectangle (negative inside).
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const qx = Math.abs(px) - hx;
      const qy = Math.abs(py) - hy;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const distance = outside + Math.min(Math.max(qx, qy), 0) - r;
      const inside = -distance;
      if (inside < 0 || inside >= b) return;
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
      const strength = (1 - inside / b) ** power;
      const i = (y * w + x) * 4;
      // Inward: the opposite of the normal.
      image.data[i] = Math.round(128 - nx * strength * 127);
      image.data[i + 1] = Math.round(128 - ny * strength * 127);
    };
    // Only the rim: the top and bottom bands, then the left and right bands between them.
    for (let y = 0; y < h; y++) {
      if (y < band || y >= h - band) {
        for (let x = 0; x < w; x++) pixel(x, y);
      } else {
        for (let x = 0; x < Math.min(band, w); x++) pixel(x, y);
        for (let x = Math.max(band, w - band); x < w; x++) pixel(x, y);
      }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  return { setEnabled, refresh, supported, isEnabled: () => enabled };
})();
