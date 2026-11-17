/*
 * Examen civique — logique du quiz.
 * Données : questions.js (window.EXAM_DATA) · Affichage : index.html
 */
(function () {
  'use strict';

  const SESSION_KEY = 'examCivique.session.v1';
  const SEEN_KEY = 'examCivique.seen.v1';
  const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  /* ================================================================
   * Fonctions pures (sans DOM) — testables avec Node
   * ================================================================ */

  function shuffle(list, rnd) {
    const a = list.slice();
    const r = rnd || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Mélange puis tri stable : les questions les moins vues passent devant.
  function pickLeastSeen(pool, n, seen, rnd) {
    return shuffle(pool, rnd)
      .sort((x, y) => (seen[x.id] || 0) - (seen[y.id] || 0))
      .slice(0, Math.max(0, n));
  }

  // Tire un examen selon exam.distribution (thème, nombre, dont mises en situation).
  function buildExam(data, seen, rnd) {
    seen = seen || {};
    const used = new Set();
    const take = list => { list.forEach(q => used.add(q.id)); return list; };
    const chosen = [];

    for (const part of data.exam.distribution) {
      const pool = data.questions.filter(q => q.theme === part.theme);
      const nSit = Math.min(part.situations || 0, part.count);
      const sit = take(pickLeastSeen(pool.filter(q => q.type === 'situation'), nSit, seen, rnd));
      const know = take(pickLeastSeen(
        pool.filter(q => !used.has(q.id) && q.type !== 'situation'), part.count - sit.length, seen, rnd));
      let picked = sit.concat(know);
      if (picked.length < part.count) { // banque trop petite : on complète avec ce qui reste
        picked = picked.concat(take(pickLeastSeen(
          pool.filter(q => !used.has(q.id)), part.count - picked.length, seen, rnd)));
      }
      chosen.push(...picked);
    }

    return shuffle(chosen, rnd).map(q => ({
      id: q.id,
      order: shuffle(q.choices.map((_, i) => i), rnd), // ordre d'affichage des propositions
      sel: [] // index (dans q.choices) cochés par l'utilisateur
    }));
  }

  // 1 point seulement si toutes les bonnes réponses, et uniquement elles, sont cochées.
  function isCorrect(question, selected) {
    const good = new Set(question.answers);
    const sel = new Set(selected);
    return sel.size === good.size && [...sel].every(i => good.has(i));
  }

  // Normalisation pour retrouver un passage dans le texte du PDF.
  function normalizeText(s) {
    return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function buildIndex(strs) {
    let text = '';
    const map = [];
    strs.forEach((s, i) => {
      for (const ch of s) {
        const n = normalizeText(ch);
        for (let k = 0; k < n.length; k++) { text += n[k]; map.push(i); }
      }
    });
    return { text, map };
  }

  // Renvoie les index des morceaux de texte (items pdf.js) couvrant l'extrait,
  // ainsi que `exact` (true si question + réponse trouvées d'un bloc).
  function locateExcerpt(strs, excerpt) {
    const { text, map } = buildIndex(strs);
    const nq = normalizeText(excerpt.q);
    const na = normalizeText(excerpt.a);
    const full = excerpt.pdf === 'A' ? nq + 'reponse' + na : nq + na;
    const range = (s, e) => ({ items: [...new Set(map.slice(s, e))] });

    let p = text.indexOf(full);
    if (p >= 0) return Object.assign(range(p, p + full.length), { exact: true });

    p = text.indexOf(nq);
    if (p < 0) p = text.indexOf(na);
    if (p < 0) return null;
    const a = text.indexOf(na, p);
    return Object.assign(range(p, a >= 0 ? a + na.length : p + nq.length), { exact: false });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { shuffle, buildExam, isCorrect, normalizeText, locateExcerpt };
  }
  if (typeof document === 'undefined') return;

  /* ================================================================
   * Application (navigateur)
   * ================================================================ */

  let DATA = null;
  const BYID = {};
  const THEMES = {};
  let session = null;
  let timerHandle = null;
  let tickBase = 0;
  let tickCount = 0;
  let reviewFilter = 'all';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const store = {
    get(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* stockage indisponible */ } },
    del(key) { try { localStorage.removeItem(key); } catch (e) { /* idem */ } }
  };

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function fmtDuration(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
  }

  function save() { if (session) store.set(SESSION_KEY, session); }

  function show(name) {
    $$('.screen').forEach(s => { s.hidden = s.id !== 'screen-' + name; });
    $('#btn-header-home').hidden = name === 'home' || name === 'error';
    document.body.dataset.screen = name;
    window.scrollTo(0, 0);
  }

  /* ---------- Démarrage ---------- */

  function init() {
    bindStatic();
    DATA = window.EXAM_DATA;
    if (!DATA || !Array.isArray(DATA.questions) || !DATA.exam) {
      show('error');
      return;
    }
    DATA.questions.forEach(q => { BYID[q.id] = q; });
    DATA.themes.forEach(t => { THEMES[t.id] = t; });

    const saved = store.get(SESSION_KEY);
    if (saved && Array.isArray(saved.items) && saved.items.length && saved.items.every(it => BYID[it.id])) {
      session = saved;
    } else if (saved) {
      store.del(SESSION_KEY); // questions modifiées depuis : session obsolète
    }
    renderHome();
    show('home');
  }

  function bindStatic() {
    $('#btn-start').addEventListener('click', startExam);
    $('#btn-resume').addEventListener('click', openQuiz);
    $('#btn-last').addEventListener('click', () => { renderResults(); show('results'); });
    $('#btn-header-home').addEventListener('click', goHome);
    $('#btn-prev').addEventListener('click', () => go(session.current - 1));
    $('#btn-next').addEventListener('click', () => go(session.current + 1));
    $('#btn-finish').addEventListener('click', () => finishExam(false));
    $('#btn-restart').addEventListener('click', startExam);
    $('#btn-home').addEventListener('click', goHome);
    $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
      reviewFilter = b.dataset.filter;
      $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      applyReviewFilter();
    }));
    $('#pdf-close').addEventListener('click', () => $('#pdf-dialog').close());
    $('#pdf-zoom-in').addEventListener('click', () => zoomPdf(1));
    $('#pdf-zoom-out').addEventListener('click', () => zoomPdf(-1));
    $('#pdf-dialog').addEventListener('click', e => { if (e.target.id === 'pdf-dialog') e.target.close(); });
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', () => { if (document.hidden) persistElapsed(); });
    window.addEventListener('pagehide', persistElapsed);
  }

  /* ---------- Accueil ---------- */

  function renderHome() {
    const ex = DATA.exam;
    const nSit = ex.distribution.reduce((s, d) => s + (d.situations || 0), 0);
    $$('[data-fill="count"]').forEach(n => { n.textContent = ex.questionCount; });
    $$('[data-fill="duration"]').forEach(n => { n.textContent = ex.durationMinutes; });
    $$('[data-fill="pass"]').forEach(n => { n.textContent = `${ex.passMark}/${ex.questionCount}`; });
    $$('[data-fill="percent"]').forEach(n => { n.textContent = Math.round(ex.passMark / ex.questionCount * 100) + ' %'; });
    $$('[data-fill="max"]').forEach(n => { n.textContent = ex.maxChoices; });
    $('#home-split').textContent =
      `${ex.questionCount - nSit} questions de connaissance et ${nSit} mises en situation, réparties sur ${ex.distribution.length} thèmes.`;
    $('#timer-label').textContent = `Chronomètre de ${ex.durationMinutes} min`;

    $('#home-dist').replaceChildren(...ex.distribution.map(d => {
      const bank = DATA.questions.filter(q => q.theme === d.theme).length;
      return h('tr', null,
        h('td', null, THEMES[d.theme].label, h('span', { class: 'bank' }, `${bank} questions dans la banque`)),
        h('td', { class: 'num' }, d.count),
        h('td', { class: 'num' }, d.situations || '—'));
    }));
    const multi = DATA.questions.filter(q => q.answers.length > 1).length;
    $('#home-bank').textContent =
      `Banque : ${DATA.questions.length} questions, dont ${multi} à réponses multiples. ` +
      'Les questions déjà vues reviennent moins souvent.';

    const running = session && session.status === 'running';
    $('#btn-resume').hidden = !running;
    if (running) {
      const done = session.items.filter(it => it.sel.length).length;
      $('#btn-resume').textContent = `Reprendre l'examen en cours (${done}/${session.items.length} répondues)`;
    }
    $('#btn-last').hidden = !(session && session.status === 'finished');
    $('#btn-start').textContent = running ? 'Commencer un nouvel examen' : 'Commencer un examen';
  }

  function goHome() {
    if (session && session.status === 'running') { stopTimer(); save(); }
    renderHome();
    show('home');
  }

  /* ---------- Examen ---------- */

  function startExam() {
    if (session && session.status === 'running' &&
        !confirm('Un examen est en cours. Le remplacer par un nouvel examen ?')) return;
    stopTimer();
    const seen = store.get(SEEN_KEY) || {};
    const items = buildExam(DATA, seen);
    items.forEach(it => { seen[it.id] = (seen[it.id] || 0) + 1; });
    store.set(SEEN_KEY, seen);
    session = {
      status: 'running',
      items,
      current: 0,
      elapsed: 0,
      timed: $('#opt-timer').checked,
      startedAt: Date.now()
    };
    save();
    openQuiz();
  }

  function openQuiz() {
    show('quiz');
    renderQuestion();
    startTimer();
  }

  function go(index) {
    if (!session || index < 0 || index >= session.items.length) return;
    session.current = index;
    save();
    renderQuestion();
    window.scrollTo(0, 0);
  }

  function renderQuestion() {
    const it = session.items[session.current];
    const q = BYID[it.id];
    const n = session.items.length;

    $('#q-counter').textContent = `Question ${session.current + 1} / ${n}`;
    $('#q-progress').style.width = `${((session.current + 1) / n) * 100}%`;
    $('#q-theme').textContent = THEMES[q.theme].label;
    $('#q-type').hidden = q.type !== 'situation';
    $('#q-text').textContent = q.question;

    $('#q-choices').replaceChildren(...it.order.map((orig, pos) => {
      const checked = it.sel.includes(orig);
      const input = h('input', { type: 'checkbox', value: orig, checked });
      const label = h('label', { class: 'choice' + (checked ? ' is-checked' : '') },
        input,
        h('span', { class: 'box', 'aria-hidden': 'true' }),
        h('span', { class: 'letter' }, LETTERS[pos]),
        h('span', { class: 'ctext' }, q.choices[orig]));
      input.addEventListener('change', () => toggleChoice(orig, input.checked, label));
      return label;
    }));

    const last = session.current === n - 1;
    $('#btn-prev').disabled = session.current === 0;
    $('#btn-next').disabled = last;
    $('#btn-finish').classList.toggle('btn-primary', last);
    renderGrid();
  }

  function toggleChoice(orig, on, label) {
    const it = session.items[session.current];
    it.sel = it.sel.filter(i => i !== orig);
    if (on) it.sel.push(orig);
    label.classList.toggle('is-checked', on);
    save();
    renderGrid();
  }

  function renderGrid() {
    const answered = session.items.filter(it => it.sel.length).length;
    $('#q-answered').textContent = `${answered}/${session.items.length} répondues`;
    $('#q-grid').replaceChildren(...session.items.map((it, i) => h('button', {
      type: 'button',
      class: 'cell' + (it.sel.length ? ' is-answered' : '') + (i === session.current ? ' is-current' : ''),
      'aria-label': `Question ${i + 1}${it.sel.length ? ' (répondue)' : ''}`,
      'aria-current': i === session.current ? 'true' : null,
      onclick: () => go(i)
    }, i + 1)));
  }

  function onKey(e) {
    if (document.body.dataset.screen !== 'quiz' || $('#pdf-dialog').open) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight') { go(session.current + 1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') { go(session.current - 1); e.preventDefault(); return; }
    const idx = '1234'.indexOf(e.key) >= 0 ? '1234'.indexOf(e.key) : 'abcd'.indexOf(e.key.toLowerCase());
    if (idx >= 0 && e.key.length === 1) {
      const input = $$('#q-choices input')[idx];
      if (input) { input.checked = !input.checked; input.dispatchEvent(new Event('change')); }
    }
  }

  /* ---------- Chronomètre ---------- */

  function currentElapsed() {
    return session.elapsed + (timerHandle ? (Date.now() - tickBase) / 1000 : 0);
  }

  function startTimer() {
    stopTimer();
    tickBase = Date.now();
    timerHandle = setInterval(onTick, 1000);
    onTick();
  }

  function stopTimer() {
    if (!timerHandle) return;
    session.elapsed = currentElapsed();
    clearInterval(timerHandle);
    timerHandle = null;
  }

  function persistElapsed() {
    if (!session || session.status !== 'running' || !timerHandle) return;
    session.elapsed = currentElapsed();
    tickBase = Date.now();
    save();
  }

  function onTick() {
    const el = currentElapsed();
    const timer = $('#q-timer');
    if (session.timed) {
      const left = DATA.exam.durationMinutes * 60 - el;
      timer.textContent = fmtClock(left);
      timer.classList.toggle('is-low', left <= 300);
      timer.title = 'Temps restant';
      if (left <= 0) { finishExam(true); return; }
    } else {
      timer.textContent = fmtClock(el);
      timer.title = 'Temps écoulé';
    }
    if (++tickCount % 5 === 0) persistElapsed();
  }

  /* ---------- Fin et résultats ---------- */

  function finishExam(timeUp) {
    if (!session || session.status !== 'running') return;
    if (!timeUp) {
      const empty = session.items.filter(it => !it.sel.length).length;
      const msg = empty
        ? `Il reste ${empty} question${empty > 1 ? 's' : ''} sans réponse. Terminer l'examen quand même ?`
        : 'Terminer l\'examen et voir votre score ?';
      if (!confirm(msg)) return;
    }
    stopTimer();
    session.status = 'finished';
    session.timeUp = !!timeUp;
    session.finishedAt = Date.now();
    save();
    reviewFilter = 'all';
    renderResults();
    show('results');
  }

  function renderResults() {
    const ex = DATA.exam;
    const rows = session.items.map((it, i) => {
      const q = BYID[it.id];
      return { i, it, q, ok: isCorrect(q, it.sel) };
    });
    const score = rows.filter(r => r.ok).length;
    const total = rows.length;
    const pass = score >= ex.passMark;

    const ring = $('#r-ring');
    ring.style.setProperty('--p', (score / total) * 100);
    ring.classList.toggle('is-pass', pass);
    ring.classList.toggle('is-fail', !pass);
    $('#r-score').textContent = score;
    $('#r-total').textContent = `/${total}`;
    const verdict = $('#r-verdict');
    verdict.textContent = pass ? 'Réussi' : 'Pas encore';
    verdict.className = 'verdict ' + (pass ? 'is-pass' : 'is-fail');
    $('#r-message').textContent = pass
      ? `Bravo ! Vous atteignez le seuil de ${ex.passMark}/${total}.`
      : `Il manque ${ex.passMark - score} bonne${ex.passMark - score > 1 ? 's' : ''} réponse${ex.passMark - score > 1 ? 's' : ''} pour atteindre ${ex.passMark}/${total}.`;
    $('#r-detail').textContent = [
      `${Math.round(score / total * 100)} % de bonnes réponses`,
      `durée : ${fmtDuration(session.elapsed)}`,
      session.timeUp ? 'temps écoulé' : null
    ].filter(Boolean).join(' · ');

    $('#r-themes').replaceChildren(...ex.distribution.map(d => {
      const mine = rows.filter(r => r.q.theme === d.theme);
      const ok = mine.filter(r => r.ok).length;
      const pct = mine.length ? (ok / mine.length) * 100 : 0;
      return h('li', null,
        h('div', { class: 'theme-row' },
          h('span', null, THEMES[d.theme].label),
          h('strong', null, `${ok}/${mine.length}`)),
        h('div', { class: 'bar', role: 'img', 'aria-label': `${ok} sur ${mine.length}` },
          h('span', { style: `width:${pct}%` })));
    }));

    const errors = total - score;
    $('#r-count-all').textContent = total;
    $('#r-count-ko').textContent = errors;
    $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.filter === reviewFilter)));

    $('#r-list').replaceChildren(...rows.map(buildReviewItem));
    applyReviewFilter();
  }

  function applyReviewFilter() {
    $$('#r-list > li').forEach(li => { li.hidden = reviewFilter === 'ko' && li.classList.contains('is-ok'); });
    $('#r-empty').hidden = !(reviewFilter === 'ko' && !$$('#r-list > li.is-ko').length);
  }

  function buildReviewItem(r) {
    const bodyId = `rv-${r.i}`;
    const body = h('div', { class: 'review-body', id: bodyId, hidden: true });
    const toggle = h('button', { type: 'button', class: 'review-toggle', 'aria-expanded': 'false', 'aria-controls': bodyId },
      h('span', { class: 'status', 'aria-label': r.ok ? 'Bonne réponse' : 'Mauvaise réponse' }, r.ok ? '✓' : '✗'),
      h('span', { class: 'rnum' }, `${r.i + 1}.`),
      h('span', { class: 'rq' }, r.q.question),
      h('span', { class: 'chev', 'aria-hidden': 'true' }));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      if (!open && !body.childElementCount) body.append(...buildReviewBody(r));
      toggle.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
    });
    return h('li', { class: 'review-item ' + (r.ok ? 'is-ok' : 'is-ko') }, toggle, body);
  }

  function buildReviewBody(r) {
    const { it, q } = r;
    const parts = [];
    parts.push(h('div', { class: 'tags' },
      h('span', { class: 'tag' }, THEMES[q.theme].label),
      q.type === 'situation' ? h('span', { class: 'tag tag-situation' }, 'Mise en situation') : null,
      q.answers.length > 1 ? h('span', { class: 'tag' }, `${q.answers.length} bonnes réponses`) : null));
    if (!it.sel.length) parts.push(h('p', { class: 'note' }, 'Vous n\'avez coché aucune réponse.'));

    parts.push(h('ul', { class: 'review-choices' }, it.order.map((orig, pos) => {
      const good = q.answers.includes(orig);
      const sel = it.sel.includes(orig);
      let state = '', label = '';
      if (good && sel) { state = 'is-good'; label = 'Bonne réponse cochée'; }
      else if (good) { state = 'is-missed'; label = 'Bonne réponse non cochée'; }
      else if (sel) { state = 'is-bad'; label = 'Cochée à tort'; }
      return h('li', { class: `rc ${state}${sel ? ' is-selected' : ''}` },
        h('span', { class: 'box', role: 'img', 'aria-label': sel ? 'Votre choix : coché' : 'Votre choix : non coché' }),
        h('span', { class: 'letter' }, LETTERS[pos]),
        h('span', { class: 'ctext' }, q.choices[orig]),
        label ? h('span', { class: 'rc-tag' }, label) : null);
    })));

    const explain = h('div', { class: 'explain', hidden: true });
    const btn = h('button', { type: 'button', class: 'btn btn-explain', 'aria-expanded': 'false' }, 'Voir la réponse dans le PDF');
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      if (!open && !explain.childElementCount) explain.append(...buildExplain(q));
      btn.setAttribute('aria-expanded', String(!open));
      btn.textContent = open ? 'Voir la réponse dans le PDF' : 'Masquer l\'explication';
      explain.hidden = open;
    });
    parts.push(btn, explain);
    return parts;
  }

  // Page ouverte depuis le disque (file://) : le navigateur interdit de lire le PDF
  // par programme, donc pas d'aperçu surligné — on ouvre le PDF à la bonne page.
  const IS_LOCAL_FILE = location.protocol === 'file:';

  function buildExplain(q) {
    const out = [h('p', { class: 'explain-lead' },
      q.sources.length > 1 ? 'Ce que disent les fiches PDF :' : 'Ce que dit la fiche PDF :')];
    q.sources.forEach(key => {
      const ex = DATA.excerpts[key];
      if (!ex) return;
      const pdf = DATA.pdfs[ex.pdf];
      const num = key.replace(/\D/g, '');
      const href = `${encodeURI(pdf.file)}#page=${ex.page}`;
      out.push(h('figure', { class: 'excerpt' },
        h('figcaption', null, `${pdf.title} — page ${ex.page}`),
        h('blockquote', null,
          ex.pdf === 'A'
            ? [h('strong', null, `${num}. ${ex.q}`), h('span', null, `Réponse : ${ex.a}`)]
            : [h('strong', null, `${ex.q} :`), h('span', null, ex.a)]),
        h('div', { class: 'excerpt-actions' },
          IS_LOCAL_FILE
            ? h('a', { class: 'btn btn-small', href, target: '_blank', rel: 'noopener' }, `Ouvrir le PDF à la page ${ex.page}`)
            : [
              h('button', { type: 'button', class: 'btn btn-small', onclick: () => openPdfViewer(key) }, 'Afficher la page surlignée'),
              h('a', { class: 'btn btn-small btn-ghost', href, target: '_blank', rel: 'noopener' }, 'Ouvrir le PDF')
            ])));
    });
    return out;
  }

  /* ---------- Visionneuse PDF (pdf.js, chargé à la demande) ---------- */

  let pdfjsPromise = null;
  const pdfDocs = {};
  let pdfRenderToken = 0;
  const ZOOMS = [1, 1.5, 2, 2.5, 3]; // multiples de la largeur de l'écran
  let zoomIdx = null;
  let pdfKey = null;

  function zoomPdf(step) {
    const next = Math.min(ZOOMS.length - 1, Math.max(0, zoomIdx + step));
    if (next === zoomIdx || !pdfKey) return;
    zoomIdx = next;
    openPdfViewer(pdfKey);
  }

  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PDFJS_SRC;
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsPromise = null; reject(new Error('pdf.js n\'a pas pu être chargé')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  async function openPdfViewer(key) {
    const ex = DATA.excerpts[key];
    const pdf = DATA.pdfs[ex.pdf];
    const token = ++pdfRenderToken;
    if (zoomIdx === null) zoomIdx = window.innerWidth < 600 ? 2 : 0; // texte lisible sur mobile
    pdfKey = key;
    $('#pdf-zoom-out').disabled = zoomIdx === 0;
    $('#pdf-zoom-in').disabled = zoomIdx === ZOOMS.length - 1;
    const dlg = $('#pdf-dialog');
    const canvas = $('#pdf-canvas');
    const layer = $('#pdf-hl');
    const status = $('#pdf-status');

    $('#pdf-title').textContent = `${pdf.title} — page ${ex.page}`;
    $('#pdf-open').href = `${encodeURI(pdf.file)}#page=${ex.page}`;
    status.textContent = 'Chargement du PDF…';
    status.hidden = false;
    layer.replaceChildren();
    canvas.hidden = true;
    if (!dlg.open) dlg.showModal();

    try {
      const lib = await loadPdfJs();
      if (!pdfDocs[pdf.file]) {
        pdfDocs[pdf.file] = lib.getDocument(pdf.file).promise;
        pdfDocs[pdf.file].catch(() => { delete pdfDocs[pdf.file]; });
      }
      const doc = await pdfDocs[pdf.file];
      const page = await doc.getPage(ex.page);
      if (token !== pdfRenderToken) return;

      const scroller = $('#pdf-scroll');
      const base = page.getViewport({ scale: 1 });
      const cssWidth = Math.round(Math.max(280, scroller.clientWidth - 2) * ZOOMS[zoomIdx]);
      canvas.parentElement.style.width = cssWidth + 'px';
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const vp = page.getViewport({ scale: Math.min((cssWidth / base.width) * dpr, 6) });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (token !== pdfRenderToken) return;
      canvas.hidden = false;

      const content = await page.getTextContent();
      const items = content.items;
      const found = locateExcerpt(items.map(i => i.str || ''), ex);
      let firstTop = null;
      let firstLeft = null;
      if (found) {
        found.items.forEach(idx => {
          const item = items[idx];
          if (!item || !item.str || !item.str.trim()) return;
          const tx = lib.Util.transform(base.transform, item.transform);
          const fh = Math.hypot(tx[2], tx[3]);
          const top = tx[5] - fh * 1.05;
          layer.append(h('div', {
            class: 'hl',
            style: `left:${(tx[4] - 2) / base.width * 100}%;top:${top / base.height * 100}%;` +
              `width:${(item.width + 4) / base.width * 100}%;height:${fh * 1.35 / base.height * 100}%`
          }));
          if (firstTop === null || top < firstTop) firstTop = top;
          if (firstLeft === null || tx[4] < firstLeft) firstLeft = tx[4];
        });
      }
      status.hidden = !!found;
      if (!found) status.textContent = 'Passage non repéré automatiquement : voici la page complète.';
      if (firstTop !== null) {
        const y = (firstTop / base.height) * canvas.clientHeight;
        scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 3);
        scroller.scrollLeft = Math.max(0, (firstLeft / base.width) * cssWidth - 12);
      } else {
        scroller.scrollTop = 0;
        scroller.scrollLeft = 0;
      }
    } catch (err) {
      if (token !== pdfRenderToken) return;
      status.hidden = false;
      status.textContent = 'Impossible d\'afficher le PDF ici (' + (err && err.message || err) + '). Utilisez « Ouvrir le PDF complet ».';
    }
  }

  init();
})();
