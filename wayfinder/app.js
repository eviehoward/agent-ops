/* ── Helpers ─────────────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function shortDigest(digest) {
  if (!digest) return "";
  return "sha256:" + digest.replace(/^sha256:/, "").slice(0, 12);
}

function extLink(url, text, cls) {
  const a = el("a", cls, text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

function statusPill(workflow) {
  const s = workflow.status;
  const c = workflow.conclusion;
  if (s === "queued" || s === "pending" || s === "waiting") return ["Queued", "pill-info"];
  if (s === "in_progress") return ["Running", "pill-warn"];
  if (c === "success") return ["Passed", "pill-ok"];
  if (c === "failure" || c === "timed_out") return ["Failed", "pill-bad"];
  if (c === "cancelled") return ["Cancelled", "pill-neutral"];
  if (c === "skipped") return ["Skipped", "pill-neutral"];
  return ["No data", "pill-neutral"];
}

function repositoryLabel(repo) {
  if (repo.startsWith("opendatahub-io/")) return `ODH midstream · ${repo}`;
  if (repo.startsWith("red-hat-data-services/")) return `RHDS downstream · ${repo}`;
  return repo;
}

/* ── Pagination ─────────────────────────────────────────────────────── */

const PAGE_SIZE = 6;

function paginate(items, page) {
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    page,
    totalPages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    total: items.length,
  };
}

function renderPager(page, totalPages, onPage) {
  if (totalPages <= 1) return null;
  const bar = el("div", "pager");
  const prev = el("button", "pager-btn", "← Previous");
  prev.type = "button";
  prev.disabled = page <= 1;
  prev.addEventListener("click", () => onPage(page - 1));
  bar.append(prev);
  bar.append(el("span", "pager-info", `Page ${page} of ${totalPages}`));
  const next = el("button", "pager-btn", "Next →");
  next.type = "button";
  next.disabled = page >= totalPages;
  next.addEventListener("click", () => onPage(page + 1));
  bar.append(next);
  return bar;
}

const copyAttempts = new WeakMap();

async function copyCmd(text, feedback, original = feedback.textContent) {
  const previous = copyAttempts.get(feedback);
  const attempt = { original: previous?.original ?? original };
  copyAttempts.set(feedback, attempt);
  let copied;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = false;
  }
  if (copyAttempts.get(feedback) !== attempt) return;
  feedback.textContent = copied ? "Copied!" : "Error";
  if (copied) feedback.dataset.copied = "";
  else delete feedback.dataset.copied;
  setTimeout(() => {
    if (copyAttempts.get(feedback) !== attempt) return;
    feedback.textContent = attempt.original;
    delete feedback.dataset.copied;
    copyAttempts.delete(feedback);
  }, 1400);
}

function cmdBlock(value, label) {
  const pull = el("div", "image-pull");
  const command = el("code", "image-command");
  command.textContent = value;
  command.tabIndex = 0;
  const copy = el("button", "image-copy");
  const feedback = el("span", "image-copy-icon");
  feedback.setAttribute("aria-live", "polite");
  copy.type = "button";
  copy.title = label;
  copy.setAttribute("aria-label", label);
  copy.append(feedback);
  copy.addEventListener("click", () => copyCmd(command.textContent, feedback, ""));
  pull.append(command, copy);
  return { pull, command };
}

/* ── Data fetching ──────────────────────────────────────────────────── */

let catalog = null;
let liveData = null;
let liveDataError = false;

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${path} failed: HTTP ${response.status}`);
  return response.json();
}

function requireRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${path}: expected an object`);
  }
}

function requireText(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Invalid ${path}: expected nonempty text`);
  }
}

function textFields(value, fields, path) {
  for (const key of fields) {
    if (value[key] != null && typeof value[key] !== "string") {
      throw new TypeError(`Invalid ${path}.${key}: expected text`);
    }
  }
}

function webLink(value, path) {
  requireText(value, path);
  if (!["https:", "http:"].includes(new URL(value).protocol)) {
    throw new TypeError(`Invalid ${path}: expected an HTTP(S) URL`);
  }
}

function entries(value, key, path, validate, required = false) {
  const list = value[key];
  if (list == null && !required) return;
  if (!Array.isArray(list)) throw new TypeError(`Invalid ${path}.${key}: expected an array`);
  list.forEach((entry, index) => {
    const itemPath = `${path}.${key}[${index}]`;
    requireRecord(entry, itemPath);
    validate(entry, itemPath);
  });
}

function validateTag(tag, path) {
  textFields(tag, ["name", "digest", "lastModified"], path);
}

function validateData(data, kind) {
  requireRecord(data, kind);
  textFields(data, ["generatedAt"], kind);
  entries(data, "products", kind, (product, path) => {
    requireText(product.key, `${path}.key`);
    if (kind === "catalog") {
      requireText(product.name, `${path}.name`);
      textFields(product, ["tagline", "description", "sourceLabel", "releaseRepo"], path);
      if (product.source != null) webLink(product.source, `${path}.source`);
      for (const key of ["docs", "downloads"]) {
        entries(product, key, path, (item, itemPath) => {
          requireText(item.title, `${itemPath}.title`);
          textFields(item, ["detail", "value", "icon", "group"], itemPath);
          if (key === "downloads") textFields(item, ["callout", "requirements"], itemPath);
          if (key === "docs" || item.url != null) webLink(item.url, `${itemPath}.url`);
        });
      }
    }
    if (product.docsVersions != null) {
      requireRecord(product.docsVersions, `${path}.docsVersions`);
      entries(product.docsVersions, "versions", `${path}.docsVersions`, (version, versionPath) => {
        requireText(version.id, `${versionPath}.id`);
        requireText(version.label, `${versionPath}.label`);
        if (!/^(latest|dev|v\d+\.\d+\.\d+)$/.test(version.id)) throw new TypeError(`Invalid ${versionPath}.id`);
      }, true);
      requireRecord(product.docsVersions.pages, `${path}.docsVersions.pages`);
      for (const [source, versions] of Object.entries(product.docsVersions.pages)) {
        webLink(source, `${path}.docsVersions.pages key`);
        requireRecord(versions, `${path}.docsVersions.pages entry`);
        for (const url of Object.values(versions)) {
          webLink(url, `${path}.docsVersions.pages URL`);
          if (new URL(url).origin !== "https://docs.nvidia.com") throw new TypeError("Invalid documentation host");
        }
      }
    }
    entries(product, "images", path, (image, imagePath) => {
      requireText(image.name, `${imagePath}.name`);
      requireText(image.repository, `${imagePath}.repository`);
      textFields(image, ["role", "pullTag", "lastModified", "group"], imagePath);
      if (image.pull != null) {
        requireRecord(image.pull, `${imagePath}.pull`);
        validateTag(image.pull, `${imagePath}.pull`);
      }
      for (const key of ["builds", "channels"]) {
        entries(image, key, imagePath, (tag, tagPath) => {
          requireText(tag.name, `${tagPath}.name`);
          validateTag(tag, tagPath);
        });
      }
    });
    entries(product, "workflows", path, (workflow, workflowPath) => {
      requireText(workflow.name, `${workflowPath}.name`);
      requireText(workflow.repo, `${workflowPath}.repo`);
      textFields(workflow, ["status", "conclusion", "branch", "sha", "updatedAt"], workflowPath);
      if (workflow.url != null) webLink(workflow.url, `${workflowPath}.url`);
    });
    entries(product, "releases", path, (release, releasePath) => {
      requireText(release.tag, `${releasePath}.tag`);
      requireText(release.upstreamVersion, `${releasePath}.upstreamVersion`);
      if (typeof release.allBuilt !== "boolean") throw new TypeError(`Invalid ${releasePath}.allBuilt`);
      entries(release, "components", releasePath, (component, componentPath) => {
        requireText(component.repository, `${componentPath}.repository`);
        requireText(component.tag, `${componentPath}.tag`);
        if (typeof component.found !== "boolean") throw new TypeError(`Invalid ${componentPath}.found`);
        textFields(component, ["name", "digest", "lastModified"], componentPath);
        if (component.found || component.registryUrl != null) webLink(component.registryUrl, `${componentPath}.registryUrl`);
      }, true);
    });
  }, true);
  return data;
}

async function loadData() {
  liveDataError = false;
  const [cat, live] = await Promise.all([
    fetchJson("products.json").then(data => validateData(data, "catalog")),
    fetchJson("data/status.json").then(data => validateData(data, "status")).catch(error => {
      liveDataError = true;
      console.error("Live status unavailable", {
        stage: "load_status", code: "STATUS_LOAD_FAILED", resource: "data/status.json", cause: error,
      });
      return null;
    }),
  ]);
  catalog = cat;
  liveData = live;
}

function liveProduct(key) {
  return (liveData?.products || []).find(p => p.key === key) || null;
}

/* ── Sidebar ────────────────────────────────────────────────────────── */

const nav = document.getElementById("product-nav");
const syncEl = document.getElementById("sync-time");
const contentInner = document.getElementById("content-inner");
const sidebar = document.getElementById("sidebar");
const toggle = document.getElementById("menu-toggle");
let activeKey = null;
let activeTab = null;

toggle.addEventListener("click", () => sidebar.classList.toggle("open"));

function buildNav() {
  const products = catalog?.products || [];
  products.forEach(product => {
    const item = el("a", "nav-item", product.name);
    item.href = "#" + encodeURIComponent(product.key);
    item.dataset.key = product.key;
    item.addEventListener("click", event => {
      event.preventDefault();
      selectProduct(product.key);
    });
    nav.append(item);
  });
  if (liveData?.generatedAt) {
    syncEl.textContent = "Synced " + formatDate(liveData.generatedAt);
  } else if (liveDataError) {
    syncEl.textContent = "Status unavailable";
  }
}

function selectProduct(key) {
  activeKey = key;
  activeTab = null;
  nav.querySelectorAll(".nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.key === key);
  });
  sidebar.classList.remove("open");
  const product = (catalog?.products || []).find(p => p.key === key);
  if (!product) return;
  renderProduct(product);
  window.scrollTo(0, 0);
  history.replaceState(null, "", "#" + key);
}

/* ── Tab system ─────────────────────────────────────────────────────── */

const TABS = [
  { id: "install", label: "Install" },
  { id: "images", label: "Container Images" },
  { id: "docs", label: "Documentation" },
  { id: "status", label: "Status" },
  { id: "releases", label: "Releases" },
];

function renderTabs(product, live) {
  const bar = el("div", "tab-bar");
  for (const tab of TABS) {
    const btn = el("button", "tab-btn", tab.label);
    btn.id = `tab-${tab.id}`;
    btn.dataset.tab = tab.id;
    btn.type = "button";
    if (tab.id === "install") btn.classList.add("active");
    btn.addEventListener("click", () => switchTab(tab.id, product, live));
    bar.append(btn);
  }
  return bar;
}

function switchTab(tabId, product, live) {
  if (activeTab === tabId) return;
  activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  const pane = document.getElementById("tab-pane");
  if (!pane) return;
  pane.replaceChildren(renderTabContent(tabId, product, live));
  pane.scrollTop = 0;
}

function renderTabContent(tabId, product, live) {
  const frag = document.createDocumentFragment();
  switch (tabId) {
    case "status": frag.append(renderStatus(product, live)); break;
    case "releases": frag.append(renderReleases(product, live)); break;
    case "images": frag.append(renderImages(product, live)); break;
    case "install": frag.append(renderInstall(product, live)); break;
    case "docs": frag.append(renderDocs(product, live)); break;
  }
  return frag;
}

/* ── Renderers ──────────────────────────────────────────────────────── */

function renderHero(p) {
  const hero = el("div", "hero");
  hero.append(el("div", "hero-eyebrow", "Red Hat OpenShift AI"));
  hero.append(el("h1", null, p.name));
  if (p.tagline) hero.append(el("p", "hero-tagline", p.tagline));
  if (p.description) hero.append(el("p", "hero-description", p.description));
  const actions = el("div", "hero-actions");
  const primaryDoc = (p.docs || []).find(d => d.url);
  if (primaryDoc) actions.append(extLink(primaryDoc.url, "Get started →", "btn btn-primary"));
  if (p.source) actions.append(extLink(p.source, p.sourceLabel || "Source code", "btn btn-secondary"));
  hero.append(actions);
  return hero;
}

function renderE2eBanner(live) {
  const images = live?.images || [];
  const e2eImg = images.find(i => i.name === "E2E Tests");
  const workflows = live?.workflows || [];
  const ciGates = workflows.filter(w =>
    w.name.toLowerCase().includes("required ci gates") ||
    w.name.toLowerCase().includes("e2e")
  );

  const banner = el("div", "e2e-banner");
  const title = el("div", "e2e-banner-title");
  title.append(el("strong", null, "E2E test image"));

  if (e2eImg) {
    const hasStable = e2eImg.pull != null;
    if (hasStable) {
      title.append(el("span", "pill pill-info", "Image available"));
    } else {
      title.append(el("span", "pill pill-neutral", "No stable tag"));
    }
    banner.append(title);
    banner.append(el("p", "e2e-details", "Image availability only. Workflow results below are separate runs, not validation of these image digests."));

    const details = el("div", "e2e-details");
    if (e2eImg.lastModified) {
      details.append(el("span", null, "Latest build: " + formatDate(e2eImg.lastModified)));
    }
    if (e2eImg.pull?.digest) {
      details.append(el("span", "e2e-digest", shortDigest(e2eImg.pull.digest)));
    }
    const repoShort = e2eImg.repository.replace("quay.io/", "");
    details.append(extLink(`https://quay.io/repository/${repoShort}?tab=tags`, "View on Quay →", "e2e-link"));
    banner.append(details);

    if (e2eImg.builds?.length) {
      const recent = el("div", "e2e-recent");
      recent.append(el("span", "e2e-recent-label", "Recent builds:"));
      for (const b of e2eImg.builds.slice(0, 3)) {
        const tag = el("span", "e2e-tag");
        const shortName = b.name.length > 16 ? b.name.slice(0, 12) + "…" : b.name;
        tag.textContent = shortName;
        tag.title = b.name;
        recent.append(tag);
      }
      banner.append(recent);
    }
  } else {
    title.append(el("span", "pill pill-neutral", "No image data"));
    banner.append(title);
  }

  if (ciGates.length) {
    const gates = el("div", "e2e-gates");
    for (const wf of ciGates) {
      const row = el("div", "e2e-gate-row");
      const [label, cls] = statusPill(wf);
      row.append(el("span", "pill " + cls, label));
      row.append(el("span", "e2e-gate-name", `${wf.name}`));
      row.append(el("span", "e2e-gate-repo", repositoryLabel(wf.repo)));
      if (wf.updatedAt) row.append(el("span", "e2e-gate-time", formatDate(wf.updatedAt)));
      if (wf.url) row.append(extLink(wf.url, "View", "e2e-gate-link"));
      gates.append(row);
    }
    banner.append(gates);
  }

  return banner;
}

function renderReleaseList(releases, page) {
  const container = el("div", null);
  container.id = "release-list";
  const { items, totalPages } = paginate(releases, page);

  for (const rel of items) {
    const row = el("div", "release-row");
    const header = el("div", "release-header");
    const title = el("div", "release-title");
    title.append(el("strong", null, `OpenShell ${rel.upstreamVersion}`));
    title.append(el("span", "release-tag", rel.tag));
    header.append(title);
    const pillText = rel.allBuilt ? "Images available" : "Images incomplete";
    const pillCls = rel.allBuilt ? "pill pill-ok" : "pill pill-warn";
    header.append(el("span", pillCls, pillText));
    row.append(header);

    const compList = el("div", "release-components");
    for (const comp of rel.components || []) {
      const item = el("div", "release-comp");
      const statusIcon = comp.found ? "✓" : "✗";
      const statusCls = comp.found ? "comp-ok" : "comp-missing";
      item.append(el("span", statusCls, statusIcon));
      const nameShort = comp.repository.replace("quay.io/opendatahub/", "");
      item.append(el("span", "comp-label", `${nameShort}:${comp.tag}`));
      if (comp.found && comp.lastModified) {
        item.append(el("span", "comp-meta", formatDate(comp.lastModified)));
      }
      if (comp.found) {
        item.append(extLink(`${comp.registryUrl}?tab=tags&tag=${comp.tag}`, "Quay", "comp-link"));
      }
      compList.append(item);
    }
    row.append(compList);
    container.append(row);
  }

  const pager = renderPager(page, totalPages, p => {
    const old = document.getElementById("release-list");
    old.replaceWith(renderReleaseList(releases, p));
  });
  if (pager) container.append(pager);
  return container;
}

function renderReleases(product, live) {
  const section = el("div", "section");
  section.append(el("h2", null, "Version releases"));
  section.append(el("p", "section-lead", "Version-tagged ODH midstream images. An upstream release appears here after an ODH release tag is created; each component is then checked in Quay. Image availability does not establish deployment validation."));
  if (product.releaseRepo) {
    section.append(extLink(`https://github.com/${product.releaseRepo}/tags`, "ODH midstream release tags →", "doc-open"));
  }
  if (!live) {
    section.append(el("p", "section-lead", "Release data unavailable."));
    return section;
  }
  const releases = live?.releases || [];
  if (!releases.length) {
    section.append(el("p", "section-lead", "No version-tagged releases found."));
    return section;
  }
  section.append(renderReleaseList(releases, 1));
  return section;
}

function imageTagPicker(label, options) {
  const field = el("label", "image-tag-picker", label);
  const select = el("select");
  for (const [value, title] of options) {
    const option = el("option", null, title);
    option.value = value;
    select.append(option);
  }
  field.append(select);
  return { field, select };
}

function defaultImageTag(img) {
  return img.pullTag || "odh-stable";
}

function renderImageCard(img, liveImg, sharedTag) {
  const card = el("article", "image-card");
  const header = el("header", "image-header");
  const title = el("div", "image-title");
  title.append(el("h4", null, img.name));
  if (img.role) title.append(el("p", "role", img.role));
  header.append(title);
  card.append(header);

  const defaultTag = defaultImageTag(img);
  const repo = img.repository.replace(/^quay\.io\//, "");
  const tagsUrl = `https://quay.io/repository/${repo}?tab=tags`;
  const quayLink = extLink(tagsUrl, "View on Quay ↗", "image-quay-link");

  const tags = new Map([[defaultTag, {}]]);
  const builds = liveImg?.builds || [];
  const versionTags = builds.filter(tag => /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag.name));
  for (const tag of [...(liveImg?.channels || []), ...versionTags]) tags.set(tag.name, tag);
  if (liveImg?.pull) tags.set(liveImg.pull.name || liveImg.pullTag || defaultTag, liveImg.pull);

  let picker;
  if (!sharedTag && tags.size > 1) {
    picker = imageTagPicker(null, [...tags.keys()].map(tag => [tag, tag]));
    picker.select.setAttribute("aria-label", `Tag for ${img.name}`);
    header.append(picker.field);
  }

  const { pull, command } = cmdBlock("", `Copy pull command for ${img.name}`);
  const meta = el("div", "image-tag-meta");
  const updated = el("span", "image-meta image-timestamp");
  const separator = el("span", "image-meta-separator", "·");
  separator.setAttribute("aria-hidden", "true");
  const toggle = el("button", "image-digest-toggle");
  toggle.type = "button";
  const digest = el("code", "image-digest image-selected-digest");
  digest.id = `image-sha-${encodeURIComponent(img.repository)}`;
  toggle.setAttribute("aria-controls", digest.id);
  toggle.addEventListener("click", () => showDigest(digest.hidden));
  meta.append(updated, separator, toggle, quayLink);
  card.append(pull, meta, digest);

  function showDigest(visible) {
    digest.hidden = !visible;
    toggle.textContent = visible ? "Hide digest" : "Show digest";
    toggle.setAttribute("aria-expanded", String(visible));
  }

  function update() {
    const component = sharedTag?.();
    const tag = component?.tag || picker?.select.value || defaultTag;
    const metadata = component || tags.get(tag);
    command.textContent = `podman pull ${img.repository}:${tag}`;
    updated.textContent = metadata?.lastModified ? `Tag updated ${formatDate(metadata.lastModified)}` : "";
    digest.textContent = metadata?.digest || "";
    toggle.hidden = !digest.textContent;
    separator.hidden = toggle.hidden || !updated.textContent;
    showDigest(false);
  }

  if (picker) {
    picker.select.value = defaultTag;
    picker.select.addEventListener("change", update);
  }
  update();

  const history = el("details", "image-builds");
  const historyLabel = builds.length ? `Recent builds (${builds.length} cached)` : "Recent builds";
  history.append(el("summary", null, historyLabel));
  if (!builds.length) history.append(el("p", "image-meta", "No recent builds in this snapshot."));
  for (const build of builds) {
    const row = el("div", "image-build-row");
    row.append(el("code", "image-build-tag", build.name));
    if (build.lastModified) row.append(el("p", "image-meta image-timestamp", `Tag updated ${formatDate(build.lastModified)}`));
    const registry = el("div", "image-registry");
    registry.append(el("code", "image-digest", build.digest || "Digest unavailable"));
    const copyDigest = el("button", "image-build-copy");
    copyDigest.type = "button";
    copyDigest.disabled = !build.digest;
    const icon = el("span", "image-copy-icon");
    icon.setAttribute("aria-hidden", "true");
    const label = el("span", "image-build-copy-label", "Copy pull command");
    label.setAttribute("aria-live", "polite");
    copyDigest.append(label, icon);
    copyDigest.addEventListener("click", () => copyCmd(`podman pull ${img.repository}@${build.digest}`, label));
    registry.append(copyDigest);
    row.append(registry);
    history.append(row);
  }
  history.append(extLink(tagsUrl, "Browse all tags on Quay ↗", "image-tags-link"));
  card.append(history);
  return { card, update };
}

function coreImageReleases(core, live) {
  const releases = new Map();
  for (const release of live?.releases || []) {
    if (!release.allBuilt) continue;
    const components = new Map(release.components.filter(c => c.found).map(c => [c.repository, c]));
    if (core.every(image => components.has(image.repository))) releases.set(release.tag, components);
  }
  return releases;
}

function renderImages(product, live) {
  const section = el("div", "section");
  const intro = el("header", "images-intro");
  intro.append(el("h2", null, "Container images"));
  intro.append(el("p", "section-lead", "Published to the Open Data Hub and AIPCC Quay organisations. Pull with Podman or Docker."));
  section.append(intro);
  const liveImages = new Map((live?.images || []).map(image => [image.repository, image]));
  const images = product.images || [];
  const core = images.filter(image => image.release);
  const groups = new Map();
  for (const image of images.filter(image => !image.release)) {
    const title = image.group || "Additional images";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(image);
  }

  if (core.length) {
    const group = el("section", "image-group");
    const header = el("header", "image-group-header");
    const title = el("div");
    title.append(el("h3", null, "Core images"));
    title.append(el("p", null, "Each release tag is available for all core images."));
    const releases = coreImageReleases(core, live);
    const defaults = new Set(core.map(defaultImageTag));
    const defaultLabel = defaults.size !== 1 ? "Default tags"
      : defaults.has("odh-stable") ? "odh-stable (rolling)" : defaultImageTag(core[0]);
    const picker = imageTagPicker("Core tag", [["", defaultLabel], ...[...releases.keys()].map(tag => [tag, tag])]);
    header.append(title, picker.field);
    group.append(header);

    const cards = core.map(image => renderImageCard(image, liveImages.get(image.repository),
      () => releases.get(picker.select.value)?.get(image.repository)));
    picker.select.addEventListener("change", () => cards.forEach(({ update }) => update()));
    group.append(...cards.map(({ card }) => card));
    section.append(group);
  }

  const groupDescriptions = new Map([
    ["Dashboard and testing", "Manage workspaces in the web UI or run end-to-end tests."],
    ["Alternative runtimes", "Choose a sandbox image with your preferred agent harness built in."],
  ]);
  for (const [title, members] of groups) {
    const group = el("section", "image-group");
    const header = el("header", "image-group-header");
    const heading = el("div");
    heading.append(el("h3", null, title));
    const description = groupDescriptions.get(title);
    if (description) heading.append(el("p", null, description));
    header.append(heading);
    group.append(header, ...members.map(image => renderImageCard(image, liveImages.get(image.repository)).card));
    section.append(group);
  }
  if (!images.length) section.append(el("p", "section-lead", "No container images listed."));
  return section;
}

function renderWorkflowPage(workflows, page, paneId) {
  const container = el("div", null);
  container.id = paneId;
  const { items, totalPages } = paginate(workflows, page);
  const list = el("ul", "checks-list");
  for (const wf of items) {
    const row = el("li", "check-row");
    const info = el("div", "check-info");
    info.append(el("div", "check-name", wf.name));
    const meta = [wf.branch, formatDate(wf.updatedAt)].filter(Boolean).join(" · ");
    if (meta) info.append(el("div", "check-meta", meta));
    row.append(info);
    const [label, cls] = statusPill(wf);
    row.append(el("span", "pill " + cls, label));
    if (wf.url) row.append(extLink(wf.url, "View", "check-link"));
    list.append(row);
  }
  container.append(list);
  const pager = renderPager(page, totalPages, p => {
    document.getElementById(paneId).replaceWith(renderWorkflowPage(workflows, p, paneId));
  });
  if (pager) container.append(pager);
  return container;
}

function renderStatus(product, live) {
  const section = el("div", "section");
  section.append(renderE2eBanner(live));

  const workflows = live?.workflows || [];
  if (!workflows.length) {
    section.append(el("p", "section-lead", "No CI workflow data available."));
    return section;
  }

  section.append(el("h2", null, "CI status"));
  section.append(el("p", "section-lead", "Public GitHub Actions workflows from ODH midstream and RHDS downstream. These runs are not tied to the image digests shown on this page."));

  const groups = new Map();
  for (const wf of workflows) {
    const repo = wf.repo || "unknown";
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push(wf);
  }
  const repos = [...groups.keys()];

  if (repos.length > 1) {
    const subBar = el("div", "sub-tab-bar");
    const pane = el("div", null);
    pane.id = "status-sub-pane";

    repos.forEach((repo, i) => {
      const btn = el("button", "sub-tab-btn", repositoryLabel(repo));
      btn.dataset.repo = repo;
      btn.type = "button";
      if (i === 0) btn.classList.add("active");
      btn.addEventListener("click", () => {
        subBar.querySelectorAll(".sub-tab-btn").forEach(b => {
          b.classList.toggle("active", b.dataset.repo === repo);
        });
        const content = el("div", null);
        content.id = "status-sub-pane";
        const paneId = "wf-" + repo.replace(/\//g, "-");
        content.append(renderWorkflowPage(groups.get(repo), 1, paneId));
        document.getElementById("status-sub-pane").replaceWith(content);
      });
      subBar.append(btn);
    });

    section.append(subBar);
    const firstPaneId = "wf-" + repos[0].replace(/\//g, "-");
    pane.append(renderWorkflowPage(groups.get(repos[0]), 1, firstPaneId));
    section.append(pane);
  } else if (repos.length === 1) {
    const groupLabel = el("div", "check-group-label");
    groupLabel.append(extLink(`https://github.com/${repos[0]}/actions`, repositoryLabel(repos[0]), null));
    section.append(groupLabel);
    const paneId = "wf-" + repos[0].replace(/\//g, "-");
    section.append(renderWorkflowPage(groups.get(repos[0]), 1, paneId));
  }

  return section;
}

function renderInstallGrid(downloads, page, groupId) {
  const container = el("div", null);
  container.id = groupId;
  const { items, totalPages } = paginate(downloads, page);
  const grid = el("div", "cards install-options");
  for (const dl of items) {
    const card = el("div", "card");
    const header = el("header", "image-header");
    const info = el("div", "install-info image-title");
    const heading = el("div", "install-heading");
    heading.append(el("h4", null, dl.title));
    if (dl.callout) {
      heading.append(el("span", "install-callout", dl.callout));
    }
    info.append(heading);
    if (dl.detail) info.append(el("p", null, dl.detail));
    if (dl.requirements) {
      const requirements = el("p", "install-requirements");
      requirements.append(el("strong", null, "Requirements: "), document.createTextNode(dl.requirements));
      info.append(requirements);
    }
    header.append(info);
    card.append(header);
    const actions = el("div", "install-actions");
    if (dl.value) {
      const { pull } = cmdBlock(dl.value, `Copy command for ${dl.title}`);
      actions.append(pull);
    }
    if (dl.url) {
      const footer = el("footer", "install-guide");
      footer.append(extLink(dl.url, "Open guide →", "btn btn-secondary"));
      actions.append(footer);
    }
    if (dl.value || dl.url) card.append(actions);
    grid.append(card);
  }
  container.append(grid);
  const pager = renderPager(page, totalPages, p => {
    document.getElementById(groupId).replaceWith(renderInstallGrid(downloads, p, groupId));
  });
  if (pager) container.append(pager);
  return container;
}

function renderInstall(p, live) {
  const section = el("div", "section install-section");
  section.append(el("h2", null, "Install"));
  function tabLink(tabId, label) {
    const link = el("a", "section-lead-link", label);
    const targetId = `tab-${tabId}`;
    link.href = `#${targetId}`;
    link.addEventListener("click", event => {
      event.preventDefault();
      switchTab(tabId, p, live);
      document.getElementById(targetId)?.focus();
    });
    return link;
  }
  const lead = el("p", "section-lead");
  lead.append(
    document.createTextNode("Start with the OpenShift walkthrough. For more info, see the "),
    tabLink("docs", "documentation"),
    document.createTextNode(" tab. For a full list of available images, see "),
    tabLink("images", "Container Images"),
    document.createTextNode("."),
  );
  section.append(lead);
  const downloads = p.downloads || [];
  const groups = [
    ["Getting started", "install-getting-started", downloads.filter(dl => dl.url)],
    ["Quick install", "install-quick", downloads.filter(dl => !dl.url)],
  ];
  for (const [title, id, items] of groups) {
    if (!items.length) continue;
    const group = el("section", "install-group");
    const header = el("header", "image-group-header install-group-header");
    header.append(el("h3", null, title));
    group.append(header, renderInstallGrid(items, 1, id));
    section.append(group);
  }
  return section;
}

function renderDocs(p, live) {
  const section = el("div", "section docs-section");
  section.append(el("h2", null, "Documentation"));
  section.append(el("p", "section-lead", "Everything you need to deploy, configure, and operate."));
  const groupDescriptions = new Map([
    ["Agent Ops guides", "Step-by-step guides and demos to get you started."],
    ["NVIDIA OpenShell documentation", "Choose the docs that match your deployment. Versions reflect the last sync, Dev follows development builds."],
    ["Midstream/downstream reference", "OpenShell references for Open Data Hub (ODH) midstream and Red Hat Data Services (RHDS) downstream."],
  ]);
  const groups = new Map();
  for (const doc of p.docs || []) {
    const group = doc.group || "Documentation";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(doc);
  }
  for (const [name, docs] of groups) {
    const group = el("section", "docs-group");
    const header = el("header", "docs-group-header");
    const heading = el("div", "docs-group-heading");
    heading.append(el("h3", "docs-group-title", name));
    const description = groupDescriptions.get(name);
    if (description) heading.append(el("p", "docs-group-note", description));
    header.append(heading);
    const nvidia = name === "NVIDIA OpenShell documentation";
    const metadata = live?.docsVersions;
    const latestVersion = metadata?.versions?.find(v => v.id === "latest")?.label.match(/^Latest \((v\d+\.\d+\.\d+)\)$/)?.[1];
    const grid = el("div", "cards docs-cards");
    function updateCards(version) {
      const cards = docs.map(doc => {
        const url = !nvidia ? doc.url : version === "latest"
          ? (latestVersion ? doc.url.replace("/openshell/latest/", `/openshell/${latestVersion}/`) : doc.url)
          : metadata?.pages?.[doc.url]?.[version];
        const card = url ? extLink(url, null, "card doc-card") : el("div", "card doc-card doc-unavailable");
        card.append(el("h4", null, doc.title));
        if (doc.detail) card.append(el("p", null, doc.detail));
        card.append(el("span", "doc-open", url ? "Open ↗" : "Not available in this version"));
        return card;
      });
      grid.replaceChildren(...cards);
    }
    if (nvidia) {
      const versions = metadata?.versions || [{ id: "latest", label: "Latest" }];
      const picker = imageTagPicker("Docs version", versions.map(v => [v.id, v.label]));
      picker.field.classList.add("docs-version-picker");
      picker.select.value = "latest";
      picker.select.addEventListener("change", () => updateCards(picker.select.value));
      header.append(picker.field);
    }
    group.append(header);
    if (nvidia && !metadata) group.append(el("p", "docs-group-note docs-version-notice", "Version information is unavailable; use the selector on NVIDIA’s site."));
    updateCards("latest");
    group.append(grid);
    section.append(group);
  }
  return section;
}

/* ── Product page assembly ──────────────────────────────────────────── */

function renderProduct(p) {
  const live = liveProduct(p.key);
  const fragment = document.createDocumentFragment();
  fragment.append(renderHero(p));
  if (liveDataError) {
    const notice = el("p", "requirements", "Live image, CI, and release status is unavailable. Documentation and install links remain available.");
    notice.setAttribute("role", "alert");
    fragment.append(notice);
  }
  fragment.append(renderTabs(p, live));
  const pane = el("div", null);
  pane.id = "tab-pane";
  activeTab = "install";
  pane.append(renderTabContent("install", p, live));
  fragment.append(pane);
  contentInner.replaceChildren(fragment);
}

/* ── Init ───────────────────────────────────────────────────────────── */

(async () => {
  try {
    await loadData();
    buildNav();
    const hash = location.hash.replace("#", "");
    const first = (catalog?.products || [])[0];
    const initial = hash && (catalog?.products || []).find(p => p.key === hash) ? hash : first?.key;
    if (initial) selectProduct(initial);
  } catch (err) {
    console.error("Page initialization failed", {
      stage: "initialize_page", code: "PAGE_INIT_FAILED", cause: err,
    });
    const splash = el("div", "splash");
    splash.append(el("h1", null, "Could not load"));
    splash.append(el("p", null, "The page could not be loaded. Please try again later."));
    contentInner.replaceChildren(splash);
  }
})();
