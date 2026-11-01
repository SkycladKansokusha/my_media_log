/**
 * main.js — entry point. Wires data (store.js), DOM (render.js),
 * navigation (router.js) and animation (motion.js / tilt.js) together.
 *
 * Reading order if you're new: config.js → store.js → render.js → this file.
 */

import { STRINGS, t } from './strings.js';
import { SECTIONS, CATEGORIES, MOTION, DEFAULT_SORT } from './config.js';
import { loadSettings, loadCategory, filterEntries, sortEntries, collectTags, computeStats, displayTitles } from './store.js';
import { current, onRouteChange, hashFor } from './router.js';
import { h, createCard, emptyState, errorState, formatDate } from './render.js';
import { Spring, spring, animateNumber, prefersReducedMotion, staggerDelay, wait, cssEasings } from './motion.js';
import { attachTilt, enableDeviceTilt } from './tilt.js';
import { initDetail, openDetail } from './detail.js';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  settings: null,
  route: null, // { section, sub }
  entries: [], // all entries of the current category
  views: {}, // per category: { query, sort, dir, tags:Set }
};

const viewFor = (category) =>
  (state.views[category] ||= { query: '', sort: DEFAULT_SORT.key, dir: DEFAULT_SORT.dir, tags: new Set() });

const $ = (id) => document.getElementById(id);
const el = {}; // cached elements, filled in cacheElements()

let tilts = []; // tilt instances of the cards currently on screen
let renderToken = 0; // guards against out-of-order async renders

/* ------------------------------------------------------------------ *
 * Static text (everything comes from strings.js)
 * ------------------------------------------------------------------ */

function cacheElements() {
  for (const id of [
    'brand', 'brand-name', 'brand-tag', 'mainnav', 'mainnav-list', 'hero-num', 'hero-code', 'hero-title',
    'subnav', 'subnav-list', 'subnav-bar', 'stats', 'stat-total-label', 'stat-total', 'stat-avg-label', 'stat-avg',
    'stat-avg-unit', 'stat-latest-label', 'stat-latest-title', 'stat-latest-date', 'controls', 'search', 'search-label',
    'search-clear', 'sort-label', 'sort-buttons', 'sort-dir', 'result-count', 'tagbar', 'tags-label', 'tag-list',
    'tags-clear', 'grid', 'footer-tagline', 'footer-scroll', 'skip-link',
  ]) {
    el[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id); // "stat-total" → el.statTotal
  }
}

function applyStaticStrings() {
  document.title = STRINGS.site.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', STRINGS.site.description);
  el.skipLink.textContent = STRINGS.site.skipToContent;
  el.brand.setAttribute('aria-label', STRINGS.site.homeLabel);
  el.brandName.textContent = STRINGS.site.brand;
  el.brandTag.textContent = STRINGS.site.brandTag;
  el.mainnav.setAttribute('aria-label', STRINGS.nav.label);
  el.subnav.setAttribute('aria-label', STRINGS.nav.subLabel);
  el.stats.setAttribute('aria-label', STRINGS.stats.label);
  el.statTotalLabel.textContent = STRINGS.stats.total;
  el.statAvgLabel.textContent = STRINGS.stats.average;
  el.statAvgUnit.textContent = STRINGS.stats.averageUnit;
  el.statLatestLabel.textContent = STRINGS.stats.latest;
  el.controls.setAttribute('aria-label', STRINGS.toolbar.label);
  el.searchLabel.textContent = STRINGS.toolbar.searchLabel;
  el.search.placeholder = STRINGS.toolbar.searchPlaceholder;
  el.searchClear.setAttribute('aria-label', STRINGS.toolbar.clearSearch);
  el.sortLabel.textContent = STRINGS.toolbar.sortLabel;
  el.sortDir.setAttribute('aria-label', STRINGS.toolbar.toggleDir);
  el.tagsLabel.textContent = STRINGS.toolbar.tagsLabel;
  el.tagList.setAttribute('aria-label', STRINGS.toolbar.tagFilterLabel);
  el.tagsClear.textContent = STRINGS.toolbar.clearTags;
  el.footerTagline.textContent = STRINGS.site.tagline;
  el.footerScroll.textContent = STRINGS.site.scroll;
}

/* ------------------------------------------------------------------ *
 * Navigation (primary + sub tabs)
 * ------------------------------------------------------------------ */

function buildMainNav() {
  el.mainnavList.replaceChildren(
    ...SECTIONS.map((s) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'mainnav__link', href: hashFor(s.id), dataset: { section: s.id } },
          h('span', { class: 'mainnav__num', 'aria-hidden': 'true' }, s.number),
          h('span', { class: 'mainnav__text' }, STRINGS.sections[s.id]),
        ),
      ),
    ),
  );
}

function updateMainNav(route) {
  el.mainnavList.querySelectorAll('a').forEach((a) => {
    const on = a.dataset.section === route.section;
    a.toggleAttribute('aria-current', on);
    if (on) a.setAttribute('aria-current', 'page');
    a.href = hashFor(a.dataset.section); // remembers last sub-tab per section
  });
  el.brand.href = hashFor(SECTIONS[0].id);
}

/* Sliding underline under the active sub-tab: two springs (position, width). */
const barX = new Spring({ ...MOTION.springs.indicator, precision: 0.05, onUpdate: drawBar });
const barW = new Spring({ ...MOTION.springs.indicator, precision: 0.05, onUpdate: drawBar });
function drawBar() {
  el.subnavBar.style.transform = `translate3d(${barX.value.toFixed(2)}px,0,0) scaleX(${Math.max(0, barW.value).toFixed(2)})`;
}

function renderSubnav(route, sectionChanged) {
  const section = SECTIONS.find((s) => s.id === route.section);
  const single = section.subs.length < 2;
  el.subnav.hidden = single;
  if (single) return;

  if (sectionChanged) {
    el.subnavList.replaceChildren(
      ...section.subs.map((sub, i) =>
        h(
          'li',
          { style: { '--i': i } },
          h('a', { class: 'subnav__link', href: hashFor(section.id, sub), dataset: { sub } }, STRINGS.categories[sub]),
        ),
      ),
    );
  }
  let active = null;
  el.subnavList.querySelectorAll('a').forEach((a) => {
    const on = a.dataset.sub === route.sub;
    if (on) {
      a.setAttribute('aria-current', 'page');
      active = a;
    } else a.removeAttribute('aria-current');
  });
  // Move the underline (wait one frame so new tabs are laid out).
  requestAnimationFrame(() => {
    if (!active) return;
    const x = active.offsetLeft;
    const w = active.offsetWidth;
    if (sectionChanged || prefersReducedMotion()) {
      barX.set(x);
      barW.set(0);
      barW.to(w);
    } else {
      barX.to(x);
      barW.to(w);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Hero (section title, giant number, stats)
 * ------------------------------------------------------------------ */

/**
 * Slanted wipe-in, played with the Web Animations API (so it can be replayed
 * on every section change without fighting the CSS intro animation).
 */
function wipeIn(node, delay = 0) {
  if (prefersReducedMotion()) return;
  node.animate(
    [
      { clipPath: 'polygon(0 0, 0 0, -12% 100%, -12% 100%)', transform: 'translateX(-14px)', opacity: 0 },
      { clipPath: 'polygon(0 0, 112% 0, 100% 100%, -12% 100%)', transform: 'none', opacity: 1 },
    ],
    { duration: 620, delay, easing: cssEasings.easeOutExpo, fill: 'backwards' },
  );
}

function renderHero(route, animate) {
  const section = SECTIONS.find((s) => s.id === route.section);
  el.heroNum.textContent = section.number;
  el.heroCode.textContent = `${t(STRINGS.sectionCode, { n: section.number })}  //  ${STRINGS.categories[route.sub]}`;
  el.heroTitle.textContent = STRINGS.sections[section.id];
  if (!animate) return;
  wipeIn(el.heroCode, 0);
  wipeIn(el.heroTitle, 60);
  if (!prefersReducedMotion()) {
    el.heroNum.animate(
      [{ opacity: 0, transform: 'translateX(6%)' }, { opacity: 1, transform: 'none' }],
      { duration: 900, easing: cssEasings.easeOutExpo },
    );
  }
}

function updateHeroCode(route) {
  const section = SECTIONS.find((s) => s.id === route.section);
  el.heroCode.textContent = `${t(STRINGS.sectionCode, { n: section.number })}  //  ${STRINGS.categories[route.sub]}`;
}

function renderStats(entries) {
  const stats = computeStats(entries);
  animateNumber(el.statTotal, stats.total, { duration: MOTION.countDuration });
  animateNumber(el.statAvg, stats.average, { decimals: 1, duration: MOTION.countDuration });
  if (stats.latest) {
    const { primary } = displayTitles(stats.latest, state.settings.titleMode);
    el.statLatestTitle.textContent = primary.text;
    el.statLatestTitle.lang = primary.lang || '';
    el.statLatestDate.textContent = formatDate(stats.latest.date);
  } else {
    el.statLatestTitle.textContent = STRINGS.stats.none;
    el.statLatestDate.textContent = '';
  }
  wipeIn(el.statLatestTitle.parentElement, 120);
}

/* ------------------------------------------------------------------ *
 * Toolbar: search, sort, tags
 * ------------------------------------------------------------------ */

const SORT_KEYS = ['rating', 'date', 'title'];
const DEFAULT_DIR = { rating: 'desc', date: 'desc', title: 'asc' };

function buildToolbar() {
  el.sortButtons.replaceChildren(
    ...SORT_KEYS.map((key) =>
      h('button', { class: 'seg', type: 'button', dataset: { key }, 'aria-pressed': 'false', onclick: () => setSort(key) }, STRINGS.toolbar.sort[key]),
    ),
  );

  let timer = 0;
  el.search.addEventListener('input', () => {
    el.searchClear.hidden = !el.search.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      viewFor(state.route.sub).query = el.search.value;
      renderList({ soft: true });
    }, MOTION.searchDebounce);
  });
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.search.value) {
      e.preventDefault();
      clearSearch();
    }
  });
  el.searchClear.addEventListener('click', () => {
    clearSearch();
    el.search.focus();
  });
  el.sortDir.addEventListener('click', () => {
    const view = viewFor(state.route.sub);
    view.dir = view.dir === 'asc' ? 'desc' : 'asc';
    syncControls();
    renderList({ soft: true });
  });
  el.tagsClear.addEventListener('click', () => {
    viewFor(state.route.sub).tags.clear();
    renderTags();
    renderList({ soft: true });
  });

  // Press "/" anywhere to jump to the search box.
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/input|textarea/i.test(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      el.search.focus();
    }
  });
}

function clearSearch() {
  el.search.value = '';
  el.searchClear.hidden = true;
  viewFor(state.route.sub).query = '';
  renderList({ soft: true });
}

function setSort(key) {
  const view = viewFor(state.route.sub);
  if (view.sort === key) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
  else {
    view.sort = key;
    view.dir = DEFAULT_DIR[key];
  }
  syncControls();
  renderList({ soft: true });
}

/** Make the toolbar reflect the current category's view state. */
function syncControls() {
  const view = viewFor(state.route.sub);
  el.search.value = view.query;
  el.searchClear.hidden = !view.query;
  el.sortButtons.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === view.sort)));
  el.sortDir.dataset.dir = view.dir;
  el.sortDir.textContent = view.dir === 'asc' ? STRINGS.toolbar.dirAsc : STRINGS.toolbar.dirDesc;
}

function renderTags() {
  const view = viewFor(state.route.sub);
  const tags = collectTags(state.entries);
  // Drop selected tags that no longer exist (e.g. after editing JSON).
  for (const tag of view.tags) if (!tags.some((x) => x.tag === tag)) view.tags.delete(tag);

  el.tagbar.hidden = tags.length === 0;
  el.tagList.replaceChildren(
    ...tags.map(({ tag, count }) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(view.tags.has(tag)),
            onclick: () => {
              view.tags.has(tag) ? view.tags.delete(tag) : view.tags.add(tag);
              renderTags();
              renderList({ soft: true });
            },
          },
          h('span', {}, tag),
          h('span', { class: 'chip__count', 'aria-hidden': 'true' }, count),
        ),
      ),
    ),
  );
  el.tagsClear.hidden = view.tags.size === 0;
}

/* ------------------------------------------------------------------ *
 * Card list
 * ------------------------------------------------------------------ */

/** Cards start hidden; this observer springs them in when they scroll into view. */
const entranceObserver = new IntersectionObserver(onCardsVisible, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
let staggerScale = 1;

function onCardsVisible(records) {
  const visible = records.filter((r) => r.isIntersecting).map((r) => r.target);
  // Stagger in visual order (top-left to bottom-right).
  visible.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  visible.forEach((card, i) => {
    entranceObserver.unobserve(card);
    enterCard(card, staggerDelay(i, MOTION.stagger * staggerScale, MOTION.maxStaggerItems));
  });
}

function enterCard(card, delay) {
  if (prefersReducedMotion()) {
    card.classList.remove('is-pending');
    card.classList.add('is-lit');
    return;
  }
  const distance = MOTION.enterDistance;
  setTimeout(() => {
    if (!card.isConnected) return;
    card.classList.add('is-lit'); // triggers the diamond light-up animation
    spring(0, 1, {
      ...MOTION.springs.cardEnter,
      onUpdate: (p) => {
        card.style.opacity = Math.min(1, Math.max(0, p * 1.4)).toFixed(3);
        card.style.transform = `translate3d(0, ${((1 - p) * distance).toFixed(2)}px, 0) scale(${(0.94 + 0.06 * p).toFixed(4)})`;
      },
      onDone: () => {
        card.classList.remove('is-pending');
        card.style.opacity = '';
        card.style.transform = '';
      },
    });
  }, delay);
}

function destroyTilts() {
  tilts.forEach((tilt) => tilt.destroy());
  tilts = [];
}

/** Quickly fade out the current cards (section / category switch). */
async function exitCards() {
  const cards = [...el.grid.querySelectorAll('.card')];
  if (!cards.length || prefersReducedMotion()) return;
  cards.forEach((card, i) => {
    card.style.setProperty('--exit-delay', `${Math.min(i, 8) * 12}ms`);
    card.classList.add('is-leaving');
  });
  await wait(MOTION.exitDuration + 80);
}

/**
 * Re-draw the grid for the current filters.
 * soft = true for search/sort/tag changes: shorter stagger, no exit animation.
 */
function renderList({ soft = false } = {}) {
  const category = state.route.sub;
  const view = viewFor(category);
  const mode = state.settings.titleMode;
  const filtered = sortEntries(filterEntries(state.entries, view), view.sort, view.dir);

  destroyTilts();
  entranceObserver.disconnect();
  staggerScale = soft ? 0.5 : 1;

  el.resultCount.textContent = t(STRINGS.toolbar.results, { n: filtered.length, total: state.entries.length });
  el.resultCount.setAttribute('aria-label', t(STRINGS.toolbar.resultsAria, { n: filtered.length, total: state.entries.length }));

  if (!filtered.length) {
    el.grid.replaceChildren(
      emptyState({
        isCategoryEmpty: state.entries.length === 0,
        onReset: () => {
          view.query = '';
          view.tags.clear();
          syncControls();
          renderTags();
          renderList({ soft: true });
        },
      }),
    );
    return;
  }

  const onOpen = (entry, card) =>
    openDetail(entry, card, {
      mode,
      aspect: CATEGORIES[category].aspect,
      categoryLabel: STRINGS.categories[category],
      onTag: (tag) => {
        view.query = '';
        view.tags = new Set([tag]);
        syncControls();
        renderTags();
        renderList({ soft: true });
        el.controls.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      },
    });

  const cards = filtered.map((entry) => {
    const card = createCard(entry, { mode, onOpen });
    card.classList.add('is-pending');
    return card;
  });
  el.grid.replaceChildren(...cards);
  cards.forEach((card) => {
    tilts.push(attachTilt(card));
    entranceObserver.observe(card);
  });
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

async function showRoute(route, { initial = false } = {}) {
  const token = ++renderToken;
  const prev = state.route;
  const sectionChanged = !prev || prev.section !== route.section;
  const categoryChanged = !prev || prev.sub !== route.sub;
  state.route = route;

  updateMainNav(route);
  if (sectionChanged) renderHero(route, !initial);
  else updateHeroCode(route);
  renderSubnav(route, sectionChanged);
  if (!categoryChanged) return;

  document.body.dataset.section = route.section;
  // New primary section while scrolled down: bring the section header back into view.
  if (sectionChanged && !initial && scrollY > el.controls.offsetTop) {
    scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  if (!initial) await exitCards();
  if (token !== renderToken) return; // user clicked again meanwhile

  el.grid.dataset.aspect = CATEGORIES[route.sub].aspect;
  el.grid.setAttribute('aria-busy', 'true');
  try {
    state.entries = await loadCategory(route.sub);
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    state.entries = [];
    destroyTilts();
    el.grid.replaceChildren(errorState({ file: CATEGORIES[route.sub].file, onRetry: () => { state.route = null; showRoute(current()); } }));
    el.grid.removeAttribute('aria-busy');
    return;
  }
  if (token !== renderToken) return;
  el.grid.removeAttribute('aria-busy');

  syncControls();
  renderTags();
  renderStats(state.entries);
  renderList();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/** Page-load choreography: elements marked [data-reveal] wipe in one after another. */
function playIntro() {
  document.querySelectorAll('[data-reveal]').forEach((node, i) => {
    node.style.setProperty('--reveal-delay', `${i * 70}ms`);
  });
  // Added directly (not in rAF): background tabs pause rAF, which would keep the page invisible.
  document.documentElement.classList.add('is-loaded');
}

async function boot() {
  cacheElements();
  applyStaticStrings();
  buildMainNav();
  buildToolbar();
  initDetail();
  state.settings = await loadSettings();
  document.documentElement.dataset.titleMode = state.settings.titleMode;
  if (state.settings.deviceTilt) enableDeviceTilt();

  playIntro();
  onRouteChange((route) => showRoute(route));
  showRoute(current(), { initial: true });
}

boot();
