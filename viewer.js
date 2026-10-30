// import() dinâmico funciona em file:// porque o CDN envia CORS; <script type="module"> local não.
(async () => {
const CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38";
const pdfjsLib = await import(`${CDN}/build/pdf.min.mjs`);
globalThis.pdfjsLib = pdfjsLib;
const pdfjsViewer = await import(`${CDN}/web/pdf_viewer.mjs`);
pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}/build/pdf.worker.min.mjs`;

const $ = (id) => document.getElementById(id);
const container = $("viewerContainer");
const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const viewer = new pdfjsViewer.PDFViewer({
  container, eventBus, linkService, findController,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  annotationEditorMode: pdfjsLib.AnnotationEditorType.NONE,
  annotationEditorHighlightColors: "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F",
  enableHighlightFloatingButton: true,
});
linkService.setViewer(viewer);

let pdfDoc = null, pdfBytes = null, pdfName = "documento.pdf";
let soundsByPage = new Map(); // pageIndex -> [{rect, sound}]

// ---------- carregar documento ----------
async function loadPdf(data, name) {
  pdfName = name || pdfName;
  pdfBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  stopAudio();
  const task = pdfjsLib.getDocument({ data: pdfBytes.slice() });
  pdfDoc = await task.promise;
  viewer.setDocument(pdfDoc);
  linkService.setDocument(pdfDoc, null);
  document.title = pdfName;
  $("numPages").textContent = `of ${pdfDoc.numPages}`;
  $("pageNumber").max = pdfDoc.numPages;
  buildThumbs();
  buildOutline();
  saveRecent(pdfDoc, pdfBytes, pdfName).catch(() => {});
  await extractSounds(pdfBytes);
  refreshAudioLayers();
}

// ---------- recent files (IndexedDB, last 10) ----------
const MAX_RECENT = 10;
const dbPromise = new Promise((resolve) => {
  try {
    const rq = indexedDB.open("pdf-viewer-recent", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("files", { keyPath: "id" });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => resolve(null);
  } catch { resolve(null); }
});
const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function recentStore(mode) {
  const db = await dbPromise;
  return db ? db.transaction("files", mode).objectStore("files") : null;
}
async function listRecent() {
  const s = await recentStore("readonly");
  if (!s) return [];
  return (await idbReq(s.getAll())).sort((a, b) => b.date - a.date);
}
async function makeThumb(doc) {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 220 / base.width });
  const c = document.createElement("canvas");
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp, background: "#fff" }).promise;
  return c.toDataURL("image/jpeg", 0.7);
}
async function saveRecent(doc, bytes, name) {
  const thumb = await makeThumb(doc);
  const id = `${name}|${bytes.byteLength}`;
  const s = await recentStore("readwrite");
  if (!s) return;
  s.put({ id, name, size: bytes.byteLength, date: Date.now(), thumb, data: bytes.slice() });
  const all = await listRecent();
  const s2 = await recentStore("readwrite");
  for (const old of all.slice(MAX_RECENT)) s2.delete(old.id);
  renderRecent();
}
async function renderRecent() {
  const box = $("recentList");
  const items = await listRecent();
  box.innerHTML = "";
  $("recentWrap").classList.toggle("hidden", !items.length);
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "recentCard";
    card.title = it.name;
    const img = document.createElement("img");
    img.src = it.thumb; img.alt = "";
    const nm = document.createElement("span");
    nm.textContent = it.name;
    const del = document.createElement("button");
    del.className = "recentDel"; del.textContent = "✕"; del.title = "Remove from history";
    del.onclick = async (e) => {
      e.stopPropagation();
      (await recentStore("readwrite")).delete(it.id);
      renderRecent();
    };
    card.onclick = () => loadPdf(it.data, it.name);
    card.append(img, nm, del);
    box.append(card);
  }
}
$("recentClear").onclick = async () => { (await recentStore("readwrite"))?.clear(); renderRecent(); };
renderRecent();

// ---------- extração de anotações Sound (pdf-lib) ----------
async function extractSounds(bytes) {
  soundsByPage = new Map();
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    doc.getPages().forEach((page, i) => {
      const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) return;
      for (let k = 0; k < annots.size(); k++) {
        const a = annots.lookup(k, PDFDict);
        if (!a) continue;
        // Anotação Sound, ou qualquer anotação (ex.: botão) com ação /S /Sound em /A ou /AA
        let stream = null;
        if (a.lookup(PDFName.of("Subtype"))?.toString() === "/Sound") stream = a.lookup(PDFName.of("Sound"));
        else {
          const acts = [a.lookup(PDFName.of("A"))];
          const aa = a.lookup(PDFName.of("AA"));
          if (aa instanceof PDFDict) for (const key of aa.keys()) acts.push(aa.lookup(key));
          for (const act of acts) {
            if (act instanceof PDFDict && act.lookup(PDFName.of("S"))?.toString() === "/Sound") {
              stream = act.lookup(PDFName.of("Sound"));
              break;
            }
          }
        }
        if (!(stream instanceof PDFRawStream)) continue;
        const d = stream.dict;
        const num = (key, def) => d.lookup(PDFName.of(key))?.asNumber?.() ?? def;
        const enc = d.lookup(PDFName.of("E"))?.toString().slice(1) || "Raw";
        const raw = decodePDFRawStream(stream).decode();
        const rect = a.lookup(PDFName.of("Rect"), PDFArray).asArray().map((n) => n.asNumber());
        const title = a.lookup(PDFName.of("Contents"))?.decodeText?.() || a.lookup(PDFName.of("T"))?.decodeText?.() || "";
        const sound = { raw, rate: num("R", 44100), channels: num("C", 1), bits: num("B", 8), enc, title };
        if (!soundsByPage.has(i)) soundsByPage.set(i, []);
        soundsByPage.get(i).push({ rect, sound, label: `Audio — page ${i + 1}, #${soundsByPage.get(i).length + 1}` });
      }
    });
  } catch (e) {
    console.error("Failed to extract audio", e);
  }
}

// PCM do PDF (big-endian, com/sem sinal, μ-law, A-law) -> WAV 16-bit
function soundToWav({ raw, rate, channels, bits, enc }) {
  const bytesPer = Math.max(1, bits >> 3);
  const n = Math.floor(raw.length / bytesPer);
  const pcm = new Int16Array(n);
  const ulaw = (u) => { u = ~u & 255; const t = ((u & 15) << 3) + 132 << ((u & 112) >> 4); return (u & 128) ? 132 - t : t - 132; };
  const alaw = (a) => { a ^= 0x55; let t = (a & 15) << 4; const s = (a & 112) >> 4;
    t = s === 0 ? t + 8 : s === 1 ? t + 0x108 : (t + 0x108) << (s - 1); return (a & 128) ? t : -t; };
  for (let i = 0; i < n; i++) {
    const o = i * bytesPer;
    if (enc === "muLaw") pcm[i] = ulaw(raw[o]);
    else if (enc === "ALaw") pcm[i] = alaw(raw[o]);
    else if (bytesPer === 1) pcm[i] = enc === "Signed" ? (raw[o] << 24 >> 24) << 8 : (raw[o] - 128) << 8;
    else {
      let v = (raw[o] << 8) | raw[o + 1];
      if (enc !== "Signed") v -= 32768;
      pcm[i] = v << 16 >> 16;
    }
  }
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * 2, true);
  dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, n * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- camada de botões sobre as anotações ----------
function addAudioLayer(pageView) {
  const items = soundsByPage.get(pageView.id - 1);
  const div = pageView.div;
  div.querySelector(":scope > .audioLayer")?.remove();
  if (!items || !pageView.viewport) return;
  const layer = document.createElement("div");
  layer.className = "audioLayer";
  for (const item of items) {
    const [x1, y1, x2, y2] = pageView.viewport.convertToViewportRectangle(item.rect);
    const b = document.createElement("button");
    b.className = "audioBtn";
    b.title = `Play: ${item.label}`;
    Object.assign(b.style, {
      left: Math.min(x1, x2) + "px", top: Math.min(y1, y2) + "px",
      width: Math.abs(x2 - x1) + "px", height: Math.abs(y2 - y1) + "px",
    });
    b.addEventListener("click", () => playSound(item, b));
    layer.append(b);
  }
  div.append(layer);
}
function refreshAudioLayers() {
  for (let i = 0; i < viewer.pagesCount; i++) {
    const pv = viewer.getPageView(i);
    if (pv?.renderingState > 0) addAudioLayer(pv);
  }
}
eventBus.on("pagerendered", (e) => addAudioLayer(viewer.getPageView(e.pageNumber - 1)));

// ---------- player ----------
const audio = new Audio();
let currentBtn = null, currentUrl = null;
const fmt = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

function playSound(item, btn) {
  if (currentBtn === btn && !audio.ended) { audio.paused ? audio.play() : audio.pause(); return; }
  stopAudio();
  item.url ??= URL.createObjectURL(soundToWav(item.sound));
  audio.src = item.url;
  currentBtn = btn;
  btn.classList.add("playing");
  $("apLabel").textContent = item.label;
  $("audioPlayer").classList.remove("hidden");
  audio.play();
}
function stopAudio() {
  audio.pause();
  currentBtn?.classList.remove("playing");
  currentBtn = null;
  $("audioPlayer").classList.add("hidden");
}
audio.addEventListener("play", () => ($("apPlay").textContent = "⏸"));
audio.addEventListener("pause", () => ($("apPlay").textContent = "▶"));
audio.addEventListener("ended", () => { $("apPlay").textContent = "▶"; currentBtn?.classList.remove("playing"); });
audio.addEventListener("timeupdate", () => {
  $("apSeek").value = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
  $("apTime").textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
});
$("apPlay").onclick = () => { if (audio.ended) audio.currentTime = 0; audio.paused ? audio.play() : audio.pause(); currentBtn?.classList.add("playing"); };
$("apSeek").oninput = (e) => { if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; };
$("apClose").onclick = stopAudio;

// ---------- barra de ferramentas ----------
$("prev").onclick = () => viewer.previousPage();
$("next").onclick = () => viewer.nextPage();
$("zoomIn").onclick = () => viewer.increaseScale();
$("zoomOut").onclick = () => viewer.decreaseScale();
$("pageNumber").onchange = (e) => (viewer.currentPageNumber = +e.target.value || 1);
$("scaleSelect").onchange = (e) => (viewer.currentScaleValue = e.target.value);
$("sidebarToggle").onclick = () => { $("sidebar").classList.toggle("hidden"); $("sidebarToggle").classList.toggle("active"); };
$("viewThumbs").onclick = () => switchTab("thumbs");
$("viewOutline").onclick = () => switchTab("outline");
function switchTab(t) {
  $("thumbsView").classList.toggle("hidden", t !== "thumbs");
  $("outlineView").classList.toggle("hidden", t !== "outline");
  $("viewThumbs").classList.toggle("active", t === "thumbs");
  $("viewOutline").classList.toggle("active", t === "outline");
}
$("openFile").onclick = () => $("fileInput").click();
$("fileInput").onchange = async (e) => { const f = e.target.files[0]; if (f) loadPdf(await f.arrayBuffer(), f.name); };
$("presentation").onclick = () => container.requestFullscreen?.();
// saveDocument inclui as anotações criadas no editor
async function currentBytes() {
  try { return await pdfDoc.saveDocument(); } catch { return pdfBytes; }
}
$("download").onclick = async () => {
  if (!pdfDoc) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([await currentBytes()], { type: "application/pdf" }));
  a.download = pdfName; a.click();
};
$("print").onclick = async () => {
  if (!pdfDoc) return;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0";
  frame.src = URL.createObjectURL(new Blob([await currentBytes()], { type: "application/pdf" }));
  frame.onload = () => frame.contentWindow.print();
  document.body.append(frame);
};

// ---------- annotation editor ----------
const ET = pdfjsLib.AnnotationEditorType, PT = pdfjsLib.AnnotationEditorParamsType;
const modes = { edHighlight: ET.HIGHLIGHT, edText: ET.FREETEXT, edInk: ET.INK, edStamp: ET.STAMP };
const HL_COLORS = { Yellow: "#FFFF98", Green: "#53FFBC", Blue: "#80EBFF", Pink: "#FFCBE6", Red: "#FF4F5F" };
const PEN_COLORS = { Black: "#000000", Red: "#E22850", Blue: "#0060DF", Green: "#12BC00", Orange: "#FF9400", White: "#FFFFFF" };
const chosen = { [ET.HIGHLIGHT]: "#FFFF98", [ET.FREETEXT]: "#000000", [ET.INK]: "#000000" };
let curMode = ET.NONE;

let uiManager = null;
eventBus.on("annotationeditoruimanager", (e) => { uiManager = e.uiManager; });
function param(type, value) {
  uiManager?.updateParams(type, value);
}
function applyColor(c) {
  chosen[curMode] = c;
  if (curMode === ET.HIGHLIGHT) { param(PT.HIGHLIGHT_COLOR, c); param(PT.HIGHLIGHT_DEFAULT_COLOR, c); }
  else if (curMode === ET.FREETEXT) param(PT.FREETEXT_COLOR, c);
  else if (curMode === ET.INK) param(PT.INK_COLOR, c);
  document.querySelectorAll("#edColors button").forEach((b) => b.classList.toggle("sel", b.dataset.c === c));
}
function buildPalette(mode) {
  const pal = mode === ET.HIGHLIGHT ? HL_COLORS : PEN_COLORS;
  $("edColors").innerHTML = Object.entries(pal)
    .map(([n, c]) => `<button data-c="${c}" title="${n}" style="background:${c}"></button>`).join("");
  applyColor(chosen[mode]);
}
function setEditorMode(mode) {
  viewer.annotationEditorMode = { mode };
}
const imageInput = document.createElement("input");
imageInput.type = "file";
imageInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
imageInput.onchange = () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  const layer = uiManager?.currentLayer;
  if (file && layer) layer.pasteEditor(ET.STAMP, { bitmapFile: file });
  setEditorMode(ET.NONE);
};
imageInput.oncancel = () => setEditorMode(ET.NONE);
for (const [id, mode] of Object.entries(modes)) {
  $(id).onclick = () => {
    const off = $(id).classList.contains("active");
    if (mode === ET.STAMP) {
      setEditorMode(ET.STAMP);
      if (!off) imageInput.click();
      return;
    }
    setEditorMode(off ? ET.NONE : mode);
  };
}
eventBus.on("annotationeditormodechanged", ({ mode }) => {
  curMode = mode;
  for (const [id, m] of Object.entries(modes)) $(id).classList.toggle("active", m === mode);
  document.body.classList.toggle("editing", mode !== ET.NONE);
  $("editParams").classList.toggle("hidden", mode === ET.NONE || mode === ET.STAMP);
  $("edSizeLabel").classList.toggle("hidden", mode === ET.HIGHLIGHT);
  if (mode === ET.HIGHLIGHT || mode === ET.FREETEXT || mode === ET.INK) buildPalette(mode);
  setTimeout(() => {
    if (curMode !== mode) return;
    if (mode === ET.FREETEXT) { $("edSize").value = 14; param(PT.FREETEXT_SIZE, 14); }
    if (mode === ET.INK) { $("edSize").value = 3; param(PT.INK_THICKNESS, 3); }
    if (chosen[mode]) applyColor(chosen[mode]);
  }, 50);
});
$("edColors").onclick = (e) => { const c = e.target.dataset?.c; if (c) applyColor(c); };
$("edSize").oninput = (e) => {
  const v = +e.target.value;
  if (curMode === ET.FREETEXT) param(PT.FREETEXT_SIZE, v);
  else if (curMode === ET.INK) param(PT.INK_THICKNESS, v);
};
const root = document.documentElement;
function setTheme(dark) {
  root.dataset.theme = dark ? "dark" : "light";
  $("themeToggle").textContent = dark ? "Light theme" : "Dark theme";
  localStorage.setItem("theme", dark ? "dark" : "light");
}
setTheme((localStorage.getItem("theme") ?? "dark") === "dark");
$("themeToggle").onclick = () => setTheme(root.dataset.theme !== "dark");
$("invertPages").onclick = () => {
  document.body.classList.toggle("invertPages");
  $("invertPages").classList.toggle("active");
};
const menu = $("moreMenu");
// Split view: a second, independent viewer in an iframe next to this one
const embedded = new URLSearchParams(location.search).has("embedded");
if (embedded) $("splitToggle").remove();
else {
  let pane = null;
  $("splitToggle").onclick = () => {
    if (pane) { pane.remove(); pane = null; $("splitToggle").classList.remove("active"); return; }
    pane = document.createElement("div");
    pane.id = "splitPane";
    pane.innerHTML = '<button id="splitClose" title="Close split view">✕</button><iframe src="index.html?embedded=1" title="Second PDF"></iframe>';
    pane.querySelector("#splitClose").onclick = $("splitToggle").onclick;
    document.body.append(pane);
    $("splitToggle").classList.add("active");
  };
}
new ResizeObserver(() => {
  if (!pdfDoc) return;
  const v = viewer.currentScaleValue;
  if (isNaN(+v)) viewer.currentScaleValue = v; else viewer.update();
}).observe($("viewerContainer"));
$("moreToggle").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
menu.addEventListener("click", () => menu.classList.add("hidden"));
document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.classList.add("hidden"); });

eventBus.on("pagechanging", (e) => {
  $("pageNumber").value = e.pageNumber;
  $("prev").disabled = e.pageNumber <= 1;
  $("next").disabled = e.pageNumber >= pdfDoc.numPages;
  document.querySelectorAll(".thumb").forEach((t) => t.classList.toggle("sel", +t.dataset.page === e.pageNumber));
  document.querySelector(".thumb.sel")?.scrollIntoView({ block: "nearest" });
});
eventBus.on("scalechanging", (e) => {
  const sel = $("scaleSelect");
  const v = String(viewer.currentScaleValue);
  if ([...sel.options].some((o) => o.value === v)) sel.value = v;
  else {
    let o = sel.querySelector("option.custom");
    if (!o) { o = document.createElement("option"); o.className = "custom"; sel.prepend(o); }
    o.value = v; o.textContent = Math.round(e.scale * 100) + "%"; sel.value = v;
  }
});

// ---------- miniaturas ----------
function buildThumbs() {
  const host = $("thumbsView");
  host.innerHTML = "";
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || en.target.dataset.done) continue;
      en.target.dataset.done = 1;
      renderThumb(en.target);
    }
  }, { root: host });
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const t = document.createElement("a");
    t.className = "thumb" + (n === 1 ? " sel" : "");
    t.dataset.page = n;
    t.innerHTML = `<canvas width="140" height="180"></canvas><span>${n}</span>`;
    t.onclick = () => (viewer.currentPageNumber = n);
    host.append(t); io.observe(t);
  }
}
async function renderThumb(el) {
  const page = await pdfDoc.getPage(+el.dataset.page);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 140 / base.width });
  const c = el.querySelector("canvas");
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
}

// ---------- índice ----------
async function buildOutline() {
  const host = $("outlineView");
  host.innerHTML = "";
  const outline = await pdfDoc.getOutline();
  if (!outline?.length) { host.innerHTML = '<div class="empty">This document has no outline.</div>'; return; }
  const make = (items) => {
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = it.title;
      a.onclick = () => {
        if (it.dest) linkService.goToDestination(it.dest);
        else if (it.url) window.open(it.url, "_blank", "noopener");
      };
      li.append(a);
      if (it.items?.length) li.append(make(it.items));
      ul.append(li);
    }
    return ul;
  };
  host.append(make(outline));
}

// ---------- pesquisa ----------
const fb = $("findbar");
function dispatchFind(type, again = false) {
  eventBus.dispatch("find", {
    source: window, type, query: $("findInput").value, caseSensitive: $("findCase").checked,
    entireWord: false, highlightAll: $("findHighlight").checked, findPrevious: again, matchDiacritics: false,
  });
}
$("findToggle").onclick = () => {
  fb.classList.toggle("hidden");
  $("findToggle").classList.toggle("active", !fb.classList.contains("hidden"));
  if (!fb.classList.contains("hidden")) $("findInput").focus();
};
$("findInput").oninput = () => dispatchFind("");
$("findInput").onkeydown = (e) => { if (e.key === "Enter") dispatchFind("again", e.shiftKey); if (e.key === "Escape") $("findToggle").click(); };
$("findNext").onclick = () => dispatchFind("again", false);
$("findPrev").onclick = () => dispatchFind("again", true);
$("findHighlight").onchange = () => dispatchFind("highlightallchange");
$("findCase").onchange = () => dispatchFind("casesensitivitychange");
const FOUND = pdfjsViewer.FindState ?? { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 };
eventBus.on("updatefindcontrolstate", (e) => {
  $("findInput").classList.toggle("notFound", e.state === FOUND.NOT_FOUND);
  $("findStatus").textContent = e.state === FOUND.NOT_FOUND ?   "Phrase not found"
      : e.matchesCount?.total ? `${e.matchesCount.current} of ${e.matchesCount.total}` : "";
});
eventBus.on("updatefindmatchescount", (e) => {
  $("findStatus").textContent = e.matchesCount.total ? `${e.matchesCount.current} of ${e.matchesCount.total}` : "";
});

// ---------- atalhos e drag & drop ----------
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") { e.preventDefault(); if (fb.classList.contains("hidden")) $("findToggle").click(); else $("findInput").focus(); }
  else if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  else if (e.key === "ArrowLeft" || e.key === "p") viewer.previousPage();
  else if (e.key === "ArrowRight" || e.key === "n") viewer.nextPage();
  else if (e.key === " " && audio.src && !$("audioPlayer").classList.contains("hidden")) { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); viewer.increaseScale(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); viewer.decreaseScale(); }
});
window.addEventListener("dragover", (e) => { e.preventDefault(); $("dropHint").classList.remove("hidden"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("dropHint").classList.add("hidden"); });
window.addEventListener("drop", async (e) => {
  e.preventDefault(); $("dropHint").classList.add("hidden");
  const f = e.dataTransfer.files[0];
  if (f) loadPdf(await f.arrayBuffer(), f.name);
});

// ---------- arranque ----------
eventBus.on("pagesinit", () => (viewer.currentScaleValue = "auto"));
const src = new URLSearchParams(location.search).get("file");
if (src) {
  fetch(src).then((r) => { if (!r.ok) throw 0; return r.arrayBuffer(); })
    .then((b) => loadPdf(b, src.split("/").pop()))
    .catch(() => {});
}
$("emptyOpen").onclick = () => $("fileInput").click();
eventBus.on("pagesinit", () => $("emptyState").classList.add("hidden"));

})();
