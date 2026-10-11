/**
 * Chart Library — every chart ManiaFlow knows about, from imports and from the game.
 *
 * Both sources produce the same record shape, so this screen does not branch on where a
 * chart came from except to say so. Filtering and sorting happen over the stored list and
 * the result is written into rows that already exist, rather than rebuilding the list on
 * every keystroke: a search that re-creates four hundred rows per character is a search
 * that feels broken.
 */

import { h, setText, clear, setStyles, Scope } from '../utils/dom.js';
import { panel, emptyState, note, badge, chip } from '../components/primitives.js';
import { button } from '../components/Button.js';
import { dropdown, selectDropdown } from '../components/Dropdown.js';
import { searchInput } from '../components/controls.js';
import { icon } from '../components/Icon.js';
import { Dialog, confirm } from '../components/Dialog.js';
import { displayName, displayFullName } from '../chart/ChartRecord.js';
import { formatDuration, formatBpm, formatStars, formatRelative, formatCount } from '../utils/formatters.js';
import { describeValidation } from '../chart/ChartImporter.js';

const SORTS = [
  { id: 'recent', label: 'Recently opened' },
  { id: 'added', label: 'Recently added' },
  { id: 'title', label: 'Title' },
  { id: 'artist', label: 'Artist' },
  { id: 'creator', label: 'Creator' },
  { id: 'stars', label: 'Star rating' },
  { id: 'bpm', label: 'BPM' },
  { id: 'length', label: 'Length' },
  { id: 'keys', label: 'Key count' },
  { id: 'notes', label: 'Note count' },
  { id: 'difficulty', label: 'Difficulty name' },
];

const KEY_FILTERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18];

export function createChartLibraryPage(context) {
  const { store, prefs, actions, navigate } = context;
  const scope = new Scope();
  const unicode = () => !!prefs.get('appearance.unicodeMetadata');

  const view = {
    query: '',
    sort: 'recent',
    descending: true,
    keys: 0,               // 0 = every key count
    source: 'all',         // all | local | bridge
    playableOnly: false,
  };

  /* ── controls ─────────────────────────────────────────────────────── */

  const search = searchInput({
    placeholder: 'Search title, artist, creator, difficulty or tags…',
    ariaLabel: 'Search charts',
    onInput: (value) => { view.query = value.trim().toLowerCase(); renderList(); },
  });

  const sortControl = selectDropdown({
    label: 'Sort', value: view.sort, options: SORTS, size: 'sm',
    onChange: (id) => { view.sort = id; renderList(); },
  });

  const directionButton = button({
    icon: 'sort', size: 'sm', variant: 'ghost',
    ariaLabel: 'Sort descending', tooltip: 'Descending — click to reverse',
    onClick: () => {
      view.descending = !view.descending;
      directionButton.setAttribute('aria-label', `Sort ${view.descending ? 'descending' : 'ascending'}`);
      directionButton.dataset.tooltip = `${view.descending ? 'Descending' : 'Ascending'} — click to reverse`;
      renderList();
    },
  });

  const keyFilter = dropdown({
    label: 'All keys', icon: 'sliders', size: 'sm',
    ariaLabel: 'Filter by key count',
    items: () => [
      { label: 'Every key count', checked: view.keys === 0, onClick: () => { view.keys = 0; keyFilter.setLabel('All keys'); renderList(); } },
      { type: 'separator' },
      ...KEY_FILTERS.filter((k) => k > 0).map((k) => ({
        label: `${k}K`,
        checked: view.keys === k,
        onClick: () => { view.keys = k; keyFilter.setLabel(`${k}K`); renderList(); },
      })),
    ],
  });

  const sourceFilter = dropdown({
    label: 'Any source', size: 'sm',
    ariaLabel: 'Filter by source',
    items: () => [
      { label: 'Any source', checked: view.source === 'all', onClick: () => { view.source = 'all'; sourceFilter.setLabel('Any source'); renderList(); } },
      { label: 'Imported here', checked: view.source === 'local', onClick: () => { view.source = 'local'; sourceFilter.setLabel('Imported'); renderList(); } },
      { label: 'From Ashtonk!mania', checked: view.source === 'bridge', onClick: () => { view.source = 'bridge'; sourceFilter.setLabel('From the game'); renderList(); } },
    ],
  });

  const playableToggle = chip({ label: 'Playable only', onClick: (node) => { view.playableOnly = !view.playableOnly; node.setOn(view.playableOnly); renderList(); } });

  const importButton = button({ label: 'Import', icon: 'upload', size: 'sm', onClick: () => fileInput.click() });
  const refreshButton = button({ label: 'Read from game', icon: 'plug', size: 'sm', variant: 'ghost', onClick: () => actions.refreshLibrary() });

  const fileInput = h('input', { type: 'file', multiple: true, accept: '.osu,.osz,.zip', style: { display: 'none' } });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) actions.importFiles(fileInput.files);
    fileInput.value = '';
  });

  const toolbar = h('div.row.row--wrap', { style: { gap: '8px' } },
    search.root,
    sortControl.node,
    directionButton,
    keyFilter.node,
    sourceFilter.node,
    playableToggle,
    h('div.grow'),
    importButton,
    refreshButton,
  );

  const countLine = h('div.small.muted');

  /* ── the list ─────────────────────────────────────────────────────── */

  const listBody = h('div.list', { role: 'listbox', 'aria-label': 'Charts', tabindex: '-1' });
  const listPanel = panel({ title: 'Charts', icon: 'library', body: listBody, flush: true });
  listPanel.body.style.maxHeight = 'calc(100vh - 260px)';
  listPanel.body.style.overflowY = 'auto';

  /** Rows are reused: one per record, rebuilt only when the visible set changes shape. */
  let renderedIds = [];
  let rowNodes = new Map();

  function renderList() {
    const charts = store.state.charts;
    const filtered = applyFilters(charts, view);
    setText(countLine, describeCount(filtered.length, charts.length, view));
    listPanel.setTitle(`Charts (${filtered.length})`);

    if (!charts.length) { renderEmpty(); return; }
    if (!filtered.length) { renderNoMatch(); return; }

    const ids = filtered.map((c) => c.id);
    const sameShape = ids.length === renderedIds.length && ids.every((id, i) => id === renderedIds[i]);
    if (sameShape) {
      // Nothing moved: refresh the selected state only.
      const selected = store.state.selectedChartId;
      for (const [id, node] of rowNodes) node.row.setAttribute('aria-selected', id === selected ? 'true' : 'false');
      return;
    }

    clear(listBody);
    rowNodes = new Map();
    renderedIds = ids;
    const selected = store.state.selectedChartId;
    const fragment = document.createDocumentFragment();

    filtered.forEach((record, index) => {
      const row = buildRow(record, index);
      row.row.setAttribute('aria-selected', record.id === selected ? 'true' : 'false');
      row.row.style.setProperty('--i', String(Math.min(index, 24)));
      fragment.append(row.row);
      rowNodes.set(record.id, row);
    });
    listBody.append(fragment);
  }

  function buildRow(record) {
    const validation = describeValidation(record);
    const row = h('button.list__row', {
      type: 'button', role: 'option', 'data-id': record.id,
    });

    const keysBadge = h('span.badge', record.keys ? `${record.keys}K` : '—');
    if (record.keys >= 7) keysBadge.classList.add('badge--accent');

    const stars = Number.isFinite(+record.stars) && +record.stars > 0
      ? h('span.num.small', { style: { color: 'var(--accent-bright)', minWidth: '44px' } }, (+record.stars).toFixed(2))
      : h('span.small.faint', { style: { minWidth: '44px' }, 'data-tooltip': 'Star rating comes from Ashtonk!mania. Import through the bridge to see it.' }, '—');

    const meta = [
      record.creator || null,
      record.bpm ? formatBpm(record.bpm, record.bpmMin, record.bpmMax) : null,
      record.length ? formatDuration(record.length) : null,
      record.objectCount != null ? `${formatCount(record.objectCount)} notes` : null,
      record.lnCount ? `${formatCount(record.lnCount)} LN` : null,
    ].filter(Boolean).join(' · ');

    const statusBadge = record.source === 'bridge'
      ? badge({ label: 'Game', variant: 'accent', tooltip: 'Read from Ashtonk!mania' })
      : record.problems?.length
        ? badge({ label: 'Unplayable', variant: 'danger', tooltip: record.problems[0] })
        : validation.level === 'warning'
          ? badge({ label: 'Warning', variant: 'warn', tooltip: validation.text })
          : null;

    row.append(
      keysBadge,
      h('div.grow', { style: { minWidth: 0 } },
        h('div.truncate', { style: { fontWeight: '500' } }, displayName(record, unicode())),
        h('div.xs.muted.truncate', `${record.version || 'Normal'}${meta ? ` · ${meta}` : ''}`),
      ),
      stars,
      statusBadge || h('span', { style: { minWidth: '52px' } }),
      h('span.xs.faint.shrink-0', { style: { minWidth: '62px', textAlign: 'right' } },
        record.openedAt ? formatRelative(record.openedAt) : 'never'),
    );
    row.dataset.tooltip = displayFullName(record, unicode());

    row.addEventListener('click', () => actions.openChart(record));
    row.addEventListener('dblclick', () => { actions.openChart(record); navigate('practice'); });
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); openRowMenu(record, event); });

    return { row, keysBadge, stars };
  }

  function openRowMenu(record, event) {
    Dialog.dialog({
      title: displayFullName(record, unicode()),
      size: 'wide',
      body: chartDetailBody(record),
      actions: [
        { label: 'Close', value: null },
        { label: 'Open in Practice', variant: 'primary', icon: 'practice', onClick: () => { actions.openChart(record); navigate('practice'); } },
      ],
    });
    void event;
  }

  function renderEmpty() {
    renderedIds = [];
    rowNodes = new Map();
    clear(listBody);
    listBody.append(emptyState({
      icon: 'library',
      title: 'No charts in ManiaFlow yet',
      body: 'Drop an .osu difficulty or an .osz beatmap set anywhere in this window. '
        + 'With a bridge connected, ManiaFlow can also read the library Ashtonk!mania already has.',
      actions: [
        button({ label: 'Import files', icon: 'upload', variant: 'primary', size: 'sm', onClick: () => fileInput.click() }),
        button({ label: 'Read from the game', icon: 'plug', size: 'sm', onClick: () => actions.refreshLibrary() }),
        button({ label: 'Load examples', icon: 'note', size: 'sm', variant: 'ghost', tooltip: 'Three generated sample charts that ship with ManiaFlow', onClick: () => actions.loadExamples() }),
      ],
      secondary: 'Nothing is uploaded anywhere: imported charts stay in this browser tab.',
    }));
  }

  function renderNoMatch() {
    renderedIds = [];
    rowNodes = new Map();
    clear(listBody);
    listBody.append(emptyState({
      icon: 'search',
      title: 'No chart matches those filters',
      body: `Nothing in ${formatCount(store.state.charts.length)} charts matches the current search and filters.`,
      actions: [button({ label: 'Clear filters', icon: 'refresh', size: 'sm', onClick: resetFilters })],
    }));
  }

  function resetFilters() {
    view.query = ''; view.keys = 0; view.source = 'all'; view.playableOnly = false;
    search.clear();
    keyFilter.setLabel('All keys');
    sourceFilter.setLabel('Any source');
    playableToggle.setOn(false);
    renderList();
  }

  /* ── detail panel ─────────────────────────────────────────────────── */

  const detailBody = h('div.stack');
  const detailPanel = panel({ title: 'Details', icon: 'info', body: detailBody });

  function renderDetail(record) {
    clear(detailBody);
    if (!record) {
      detailBody.append(emptyState({
        icon: 'note', title: 'No chart selected',
        body: 'Choose a chart from the list to see its metadata, validation result and analysis.',
      }));
      return;
    }
    detailBody.append(chartDetailBody(record));
  }

  function chartDetailBody(record) {
    const validation = describeValidation(record);
    const body = h('div.stack');

    body.append(h('div.stack', { style: { gap: '2px' } },
      h('div.strong', displayName(record, unicode())),
      h('div.small.muted', `[${record.version || 'Normal'}] mapped by ${record.creator || 'unknown'}`),
      h('div.row', { style: { gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
        badge({ label: record.keys ? `${record.keys}K` : 'unknown key count' }),
        badge({ label: record.source === 'bridge' ? 'From the game' : record.source === 'archive' ? 'From an archive' : 'Imported file' }),
        Number.isFinite(+record.stars) && +record.stars > 0 ? badge({ label: formatStars(+record.stars), variant: 'accent' }) : null,
        record.mode === 3 ? null : badge({ label: `mode ${record.mode}`, variant: 'warn', tooltip: 'Only osu!mania (mode 3) can be previewed locally' }),
      ),
    ));

    if (record.problems?.length || record.warnings?.length) {
      body.append(note({
        variant: record.problems?.length ? undefined : 'warn',
        icon: record.problems?.length ? 'alert' : 'info',
        title: record.problems?.length ? 'Cannot be previewed' : 'Parsed with warnings',
        text: h('div.stack', { style: { gap: '2px' } },
          ...record.problems.map((p) => h('div', p)),
          ...record.warnings.map((w) => h('div.muted', w)),
        ),
      }));
    } else {
      body.append(note({ variant: 'accent', icon: 'check', text: validation.text }));
    }

    const rows = [
      ['Key count', record.keys || '—'],
      ['BPM', record.bpm ? formatBpm(record.bpm, record.bpmMin, record.bpmMax) : '—'],
      ['Length', record.length ? formatDuration(record.length) : '—'],
      ['Drain length', record.drainLength ? formatDuration(record.drainLength) : '—'],
      ['Objects', record.objectCount != null ? formatCount(record.objectCount) : '—'],
      ['Holds', record.lnCount != null ? formatCount(record.lnCount) : '—'],
      ['Average density', record.nps != null ? `${record.nps.toFixed(2)} n/s` : '—'],
      ['Peak density', record.peakNps != null ? `${record.peakNps.toFixed(2)} n/s` : 'ManiaFlow has not analysed this chart yet'],
      ['Star rating', Number.isFinite(+record.stars) && +record.stars > 0 ? formatStars(+record.stars) : 'Only available from the game'],
      ['OD / HP', `${record.od ?? '—'} / ${record.hp ?? '—'}`],
      ['Format', record.formatVersion ? `osu! format v${record.formatVersion}` : '—'],
      ['Audio', record.audioFilename || '—'],
      ['Beatmap ID', record.onlineId ?? record.setId ?? '—'],
      ['Added', record.added ? formatRelative(record.added) : '—'],
    ];
    const table = h('dl.dl');
    for (const [label, value] of rows) {
      table.append(h('dt', label), h('dd', { class: typeof value === 'string' && /^[\d.,—]/.test(value) ? 'num' : '' }, String(value)));
    }
    body.append(table);

    if (record.analysis) {
      const chords = record.analysis.chords;
      const extra = h('div.stack', { style: { gap: '4px' } });
      extra.append(h('div.label-upper', 'ManiaFlow’s own analysis'));
      const items = [
        ['Timing changes', formatCount(record.analysis.timingChangeCount)],
        ['SV changes', formatCount(record.analysis.svChangeCount)],
        ['Chord groups', formatCount(chords?.groups ?? 0)],
        ['Widest chord', chords?.maxChord ? `${chords.maxChord} notes` : '—'],
        ['Jacks', formatCount(record.analysis.jacks?.count ?? 0)],
        ['Shortest interval', record.analysis.minIntervalMs != null ? `${Math.round(record.analysis.minIntervalMs)} ms` : '—'],
        ['Median interval', record.analysis.medianIntervalMs != null ? `${Math.round(record.analysis.medianIntervalMs)} ms` : '—'],
        ['Total hold time', record.analysis.lnTotalMs ? formatDuration(record.analysis.lnTotalMs) : '—'],
      ];
      const grid = h('div.grid.grid--2', { style: { gap: '6px' } });
      for (const [label, value] of items) {
        grid.append(h('div.row.row--between', { style: { padding: '3px 0', borderBottom: '1px solid var(--line-faint)' } },
          h('span.xs.muted', label), h('span.num.xs', value)));
      }
      extra.append(grid);
      body.append(extra);
    }

    const buttons = h('div.row.row--wrap', { style: { marginTop: '4px' } },
      button({ label: 'Practice', icon: 'practice', size: 'sm', variant: 'primary', onClick: () => { actions.openChart(record); navigate('practice'); } }),
      button({ label: 'Timing Lab', icon: 'timing', size: 'sm', onClick: () => { actions.openChart(record); navigate('timing'); } }),
      button({
        label: 'Remove', icon: 'trash', size: 'sm', variant: 'ghost',
        disabled: record.source === 'bridge',
        onClick: async () => {
          const yes = await confirm({
            title: 'Remove this chart from ManiaFlow?',
            body: `“${displayFullName(record, unicode())}” will leave this list. ${record.source === 'bridge' ? 'It stays in Ashtonk!mania.' : 'The file on disk is not touched.'}`,
            confirmLabel: 'Remove', destructive: true, icon: 'trash',
          });
          if (yes) actions.removeChart(record.id);
        },
      }),
    );
    body.append(buttons);
    return body;
  }

  /* ── layout ───────────────────────────────────────────────────────── */

  const root = h('div',
    h('div.page__head-row',
      h('div.page__head',
        h('h1.page__title', 'Chart Library'),
        h('p.page__subtitle', 'Charts imported into ManiaFlow and charts read from Ashtonk!mania. Both are the same object here; the badge says where each one came from.'),
      ),
    ),
    toolbar,
    countLine,
    fileInput,
    h('div.grid.grid--split', listPanel.root, detailPanel.root),
  );

  /* ── live updates ─────────────────────────────────────────────────── */

  scope.defer(store.subscribe((s) => s.charts, () => renderList()));
  scope.defer(store.subscribe((s) => s.selectedChartId, (id) => {
    const record = store.state.charts.find((c) => c.id === id) || null;
    renderDetail(record);
    for (const [rowId, entry] of rowNodes) entry.row.setAttribute('aria-selected', rowId === id ? 'true' : 'false');
  }));
  scope.defer(store.subscribe((s) => s.busy, (busy) => {
    setStyles(listBody, { opacity: busy ? '0.72' : '' });
    refreshButton.disabled = !!busy;
  }));
  scope.defer(store.subscribe((s) => s.integration?.capabilities?.readLibrary, (can) => {
    refreshButton.disabled = !can;
    refreshButton.dataset.tooltip = can ? 'Read the library Ashtonk!mania already has' : 'Needs a connected bridge';
  }));
  scope.defer(store.subscribe((s) => s.libraryError, (message) => {
    if (!message) return;
    clear(listBody);
    renderedIds = [];
    listBody.append(emptyState({
      icon: 'alert', title: 'The game library could not be read', body: message,
      actions: [button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: () => actions.refreshLibrary() })],
    }));
  }, { immediate: false }));

  // Keyboard: `/` focuses the search, arrows move the selection, Enter opens it.
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    const typing = event.target instanceof Element && event.target.matches('input, textarea, select');
    if (event.key === '/' && !typing) { event.preventDefault(); search.focus(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (typing) return;
      const ids = renderedIds;
      if (!ids.length) return;
      event.preventDefault();
      const current = ids.indexOf(store.state.selectedChartId);
      const next = event.key === 'ArrowDown'
        ? ids[Math.min(ids.length - 1, current + 1)]
        : ids[Math.max(0, current <= 0 ? 0 : current - 1)];
      const record = store.state.charts.find((c) => c.id === next);
      if (record) {
        actions.openChart(record);
        rowNodes.get(next)?.row.scrollIntoView({ block: 'nearest' });
      }
    }
    if (event.key === 'Enter' && !typing && store.state.loadedChart) {
      event.preventDefault();
      navigate('practice');
    }
  };
  scope.on(window, 'keydown', onKeyDown);

  renderList();
  renderDetail(store.state.charts.find((c) => c.id === store.state.selectedChartId) || null);

  return {
    root,
    focus: () => search.focus(),
    onParams(params) {
      const chartId = params?.get?.('chart');
      if (chartId) {
        const record = store.state.charts.find((c) => c.id === chartId);
        if (record) actions.openChart(record);
      }
    },
    dispose: () => scope.dispose(),
  };
}

/* ── filtering and sorting ─────────────────────────────────────────────── */

export function applyFilters(charts, view) {
  let out = Array.isArray(charts) ? charts.slice() : [];

  if (view.keys) out = out.filter((c) => c.keys === view.keys);
  if (view.source === 'local') out = out.filter((c) => c.source !== 'bridge');
  if (view.source === 'bridge') out = out.filter((c) => c.source === 'bridge');
  if (view.playableOnly) out = out.filter((c) => c.previewable && c.valid);

  if (view.query) {
    const terms = view.query.split(/\s+/).filter(Boolean);
    out = out.filter((c) => {
      const haystack = [
        c.title, c.titleUnicode, c.artist, c.artistUnicode, c.creator, c.version,
        c.sourceTag, ...(Array.isArray(c.tags) ? c.tags : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  const dir = view.descending ? -1 : 1;
  const numeric = (value) => (Number.isFinite(+value) ? +value : -1);
  const comparators = {
    recent: (a, b) => (b.openedAt || 0) - (a.openedAt || 0) || (b.added || 0) - (a.added || 0),
    added: (a, b) => (numeric(a.added) - numeric(b.added)) * dir,
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || '')) * dir,
    artist: (a, b) => String(a.artist || '').localeCompare(String(b.artist || '')) * dir,
    creator: (a, b) => String(a.creator || '').localeCompare(String(b.creator || '')) * dir,
    difficulty: (a, b) => String(a.version || '').localeCompare(String(b.version || '')) * dir,
    stars: (a, b) => (numeric(a.stars) - numeric(b.stars)) * dir,
    bpm: (a, b) => (numeric(a.bpm) - numeric(b.bpm)) * dir,
    length: (a, b) => (numeric(a.length) - numeric(b.length)) * dir,
    keys: (a, b) => (numeric(a.keys) - numeric(b.keys)) * dir,
    notes: (a, b) => (numeric(a.objectCount) - numeric(b.objectCount)) * dir,
  };
  const compare = comparators[view.sort] || comparators.recent;
  out.sort(compare);
  return out;
}

function describeCount(shown, total, view) {
  if (!total) return 'No charts yet — import a file or read the library from the game.';
  const filters = [
    view.query ? `matching “${view.query}”` : null,
    view.keys ? `${view.keys}K` : null,
    view.source === 'local' ? 'imported here' : view.source === 'bridge' ? 'from the game' : null,
    view.playableOnly ? 'playable only' : null,
  ].filter(Boolean);
  if (!filters.length) return `${formatCount(total)} chart${total === 1 ? '' : 's'}`;
  return `${formatCount(shown)} of ${formatCount(total)} charts ${filters.join(' · ')}`;
}
