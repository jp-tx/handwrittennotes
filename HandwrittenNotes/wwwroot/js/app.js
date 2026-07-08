/* global sidebar + auth logic */

// Prevent iOS long-press copy/paste dialog everywhere except actual text inputs.
// selectstart is intentionally omitted — CSS user-select handles it, and
// cancelling selectstart in JS interferes with quick consecutive stylus strokes.
(function () {
    function isTextTarget(el) {
        const tag = el.tagName;
        return tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable;
    }
    document.addEventListener('contextmenu', e => { if (!isTextTarget(e.target)) e.preventDefault(); });

    // Block all browser-native zoom (double-tap or pinch by pen or finger).
    // Our JS pinch zoom on the canvas uses pointer events and is unaffected.
    // iOS ignores user-scalable=no since iOS 10, so this JS block is required.
    document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend',    e => e.preventDefault(), { passive: false });
})();

(function () {
    'use strict';

    // ── Sidebar toggle ────────────────────────────────────────────────────────
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    if (toggleBtn && sidebar) {
        toggleBtn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
    }

    // ── Logout ────────────────────────────────────────────────────────────────
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' });
            location.href = '/Login';
        });
    }

    // ── Modal helper ──────────────────────────────────────────────────────────
    function prompt(message, defaultValue = '') {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const msgEl = document.getElementById('modalMessage');
            const inputEl = document.getElementById('modalInput');
            const confirmBtn = document.getElementById('modalConfirm');
            const cancelBtn = document.getElementById('modalCancel');

            msgEl.textContent = message;
            inputEl.value = defaultValue;
            overlay.classList.remove('hidden');
            inputEl.focus();
            inputEl.select();

            function cleanup() { overlay.classList.add('hidden'); confirmBtn.onclick = null; cancelBtn.onclick = null; inputEl.onkeydown = null; }
            confirmBtn.onclick = () => { cleanup(); resolve(inputEl.value.trim()); };
            cancelBtn.onclick = () => { cleanup(); resolve(null); };
            inputEl.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
            };
        });
    }

    // ── Drag-and-drop ─────────────────────────────────────────────────────────
    let drag = null;

    function initDragHandle(handle, type, id, notebookId, getEl) {
        handle.addEventListener('pointerdown', e => {
            if (e.button > 0) return;
            e.stopPropagation();
            handle.setPointerCapture(e.pointerId);
            const el = getEl();
            const rect = el.getBoundingClientRect();
            const ghost = el.cloneNode(true);
            Object.assign(ghost.style, {
                position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
                width: rect.width + 'px', margin: '0', opacity: '0.8',
                pointerEvents: 'none', zIndex: '9999',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            });
            document.body.appendChild(ghost);
            drag = { type, id, notebookId, el, ghost, offsetY: e.clientY - rect.top, insertBefore: undefined };
            el.classList.add('drag-source');
        });
        handle.addEventListener('click', e => e.stopPropagation());
    }

    function getDragTargets() {
        if (!drag) return [];
        if (drag.type === 'notebook') return [...document.querySelectorAll('.nb-section')];
        return [...document.querySelectorAll(`.nb-pages[data-nb-id="${drag.notebookId}"] .page-item`)];
    }

    function updateDropIndicator(clientY) {
        document.querySelectorAll('.drag-drop-indicator').forEach(el => el.remove());
        if (!drag) return;
        const targets = getDragTargets().filter(t => t !== drag.el);
        drag.insertBefore = null;
        let placed = false;
        for (const target of targets) {
            const rect = target.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                const ind = document.createElement('div');
                ind.className = 'drag-drop-indicator';
                target.parentNode.insertBefore(ind, target);
                drag.insertBefore = target;
                placed = true;
                break;
            }
        }
        if (!placed && targets.length > 0) {
            const ind = document.createElement('div');
            ind.className = 'drag-drop-indicator';
            const last = targets[targets.length - 1];
            last.parentNode.insertBefore(ind, last.nextSibling);
        }
    }

    function cancelDrag() {
        if (!drag) return;
        document.querySelectorAll('.drag-drop-indicator').forEach(el => el.remove());
        drag.ghost.remove();
        drag.el.classList.remove('drag-source');
        drag = null;
    }

    async function commitDrop() {
        if (!drag) return;
        document.querySelectorAll('.drag-drop-indicator').forEach(el => el.remove());
        drag.ghost.remove();
        drag.el.classList.remove('drag-source');

        const { type, id, notebookId, insertBefore } = drag;
        drag = null;

        if (insertBefore === undefined) return;

        const targets = type === 'notebook'
            ? [...document.querySelectorAll('.nb-section')]
            : [...document.querySelectorAll(`.nb-pages[data-nb-id="${notebookId}"] .page-item`)];

        const getId = el => type === 'notebook' ? el.dataset.nbId : el.dataset.pageId;
        const ids = targets.filter(t => getId(t) !== id).map(getId);
        const insertIdx = insertBefore ? ids.indexOf(getId(insertBefore)) : ids.length;
        ids.splice(insertIdx === -1 ? ids.length : insertIdx, 0, id);

        const url = type === 'notebook'
            ? '/api/notebooks/reorder'
            : `/api/notebooks/${notebookId}/pages/reorder`;

        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ids),
        });
        loadSidebar();
    }

    document.addEventListener('pointermove', e => {
        if (!drag) return;
        drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
        updateDropIndicator(e.clientY);
    });
    document.addEventListener('pointerup',     () => { if (drag) commitDrop(); });
    document.addEventListener('pointercancel', () => { if (drag) cancelDrag(); });

    // ── Sidebar rendering ─────────────────────────────────────────────────────
    const listEl = document.getElementById('notebookList');
    const collapseState = {};

    function activePageId() {
        const m = location.pathname.match(/\/pages\/([^/]+)/);
        return m ? m[1] : null;
    }

    function renderPage(nb, pg) {
        const active = pg.id === activePageId();
        const item = document.createElement('div');
        item.className = 'page-item' + (active ? ' active' : '');
        item.dataset.pageId = pg.id;

        const dragHandle = document.createElement('span');
        dragHandle.className = 'drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.title = 'Drag to reorder';

        const badge = document.createElement('span');
        badge.className = 'page-type-badge';
        badge.textContent = pg.type.toUpperCase();

        const name = document.createElement('span');
        name.className = 'page-name';
        name.textContent = pg.name;

        const actions = document.createElement('div');
        actions.className = 'page-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn-rename';
        renameBtn.title = 'Rename page';
        renameBtn.textContent = '✏';

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-danger';
        delBtn.title = 'Delete page';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete page "${pg.name}"?`)) return;
            await fetch(`/api/notebooks/${nb.id}/pages/${pg.id}`, { method: 'DELETE' });
            if (active) location.href = '/';
            else loadSidebar();
        });

        actions.appendChild(renameBtn);
        actions.appendChild(delBtn);
        item.appendChild(dragHandle);
        item.appendChild(badge);
        item.appendChild(name);
        item.appendChild(actions);

        item.addEventListener('click', () => {
            location.href = `/notebooks/${nb.id}/pages/${pg.id}`;
        });

        function openRename() {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'page-name-input';
            input.value = pg.name;
            item.replaceChild(input, name);
            input.focus();
            input.select();
            async function commit() {
                const val = input.value.trim();
                if (val && val !== pg.name) {
                    await fetch(`/api/notebooks/${nb.id}/pages/${pg.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: val }),
                    });
                }
                loadSidebar();
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                if (ev.key === 'Escape') { input.removeEventListener('blur', commit); item.replaceChild(name, input); }
            });
        }

        renameBtn.addEventListener('click', (e) => { e.stopPropagation(); openRename(); });
        name.addEventListener('dblclick', (e) => { e.stopPropagation(); openRename(); });

        initDragHandle(dragHandle, 'page', pg.id, nb.id, () => item);
        return item;
    }

    function renderNotebook(nb) {
        const open = collapseState[nb.id] !== false;

        const section = document.createElement('div');
        section.className = 'nb-section';
        section.dataset.nbId = nb.id;

        const header = document.createElement('div');
        header.className = 'nb-header';

        const dragHandle = document.createElement('span');
        dragHandle.className = 'drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.title = 'Drag to reorder';

        const toggle = document.createElement('span');
        toggle.className = 'nb-toggle' + (open ? ' open' : '');
        toggle.textContent = '▶';

        const nameEl = document.createElement('span');
        nameEl.className = 'nb-name';
        nameEl.textContent = nb.name;

        const actions = document.createElement('div');
        actions.className = 'nb-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn-rename';
        renameBtn.title = 'Rename notebook';
        renameBtn.textContent = '✏';

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-danger';
        delBtn.title = 'Delete notebook';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete notebook "${nb.name}" and all its pages?`)) return;
            await fetch(`/api/notebooks/${nb.id}`, { method: 'DELETE' });
            const active = activePageId();
            const hasActive = nb.pages.some(p => p.id === active);
            if (hasActive) location.href = '/';
            else loadSidebar();
        });

        actions.appendChild(renameBtn);
        actions.appendChild(delBtn);
        header.appendChild(dragHandle);
        header.appendChild(toggle);
        header.appendChild(nameEl);
        header.appendChild(actions);
        section.appendChild(header);

        const pagesWrap = document.createElement('div');
        pagesWrap.className = 'nb-pages' + (open ? '' : ' hidden');
        pagesWrap.dataset.nbId = nb.id;

        nb.pages.forEach(pg => pagesWrap.appendChild(renderPage(nb, pg)));

        const addRow = document.createElement('div');
        addRow.className = 'add-page-row';
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-page';
        addBtn.textContent = '+ Add page';
        addBtn.addEventListener('click', () => showAddPageForm(nb, addRow, addBtn));
        addRow.appendChild(addBtn);
        pagesWrap.appendChild(addRow);

        section.appendChild(pagesWrap);

        header.addEventListener('click', (e) => {
            if (e.target.closest('.nb-actions')) return;
            if (e.target.closest('.drag-handle')) return;
            if (e.target === nameEl && nameEl.isContentEditable) return;
            const isOpen = !pagesWrap.classList.contains('hidden');
            pagesWrap.classList.toggle('hidden', isOpen);
            toggle.classList.toggle('open', !isOpen);
            collapseState[nb.id] = !isOpen;
        });

        function openRename() {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'nb-name-input';
            input.value = nb.name;
            header.replaceChild(input, nameEl);
            input.focus();
            input.select();
            async function commit() {
                const val = input.value.trim();
                if (val && val !== nb.name) {
                    await fetch(`/api/notebooks/${nb.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: val }),
                    });
                }
                loadSidebar();
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                if (ev.key === 'Escape') { input.removeEventListener('blur', commit); header.replaceChild(nameEl, input); }
            });
        }

        renameBtn.addEventListener('click', (e) => { e.stopPropagation(); openRename(); });
        nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); openRename(); });

        initDragHandle(dragHandle, 'notebook', nb.id, null, () => section);
        return section;
    }

    function showAddPageForm(nb, addRow, addBtn) {
        addBtn.style.display = 'none';
        const form = document.createElement('div');
        form.className = 'add-page-form';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Page name';
        nameInput.value = 'Untitled';

        let selectedType = 'bmp';

        const typeRow = document.createElement('div');
        typeRow.className = 'add-page-form-actions';

        const bmpBtn = document.createElement('button');
        bmpBtn.className = 'btn-type active';
        bmpBtn.textContent = 'BMP';

        const txtBtn = document.createElement('button');
        txtBtn.className = 'btn-type';
        txtBtn.textContent = 'TXT';

        const styleSelect = document.createElement('select');
        styleSelect.className = 'add-page-style-select';

        const styleOptions = [
            { value: 'default',       label: 'Default size' },
            { value: '1920x1080',     label: 'Full HD Landscape (1920\xD71080)',  group: 'Canvas Size' },
            { value: '1080x1920',     label: 'Full HD Portrait (1080\xD71920)',   group: 'Canvas Size' },
            { value: '1654x2339',     label: 'A4 @ 200 DPI (1654\xD72339)',       group: 'Canvas Size' },
            { value: '2480x3508',     label: 'A4 @ 300 DPI (2480\xD73508)',       group: 'Canvas Size' },
            { value: '1080x1080',     label: 'Square HD (1080\xD71080)',           group: 'Canvas Size' },
            { value: '3840x2160',     label: '4K Landscape (3840\xD72160)',        group: 'Canvas Size' },
            { value: 'lined-wide',    label: 'Lined — Wide Rule',            group: 'Lined Pages' },
            { value: 'lined-college', label: 'Lined — College Rule',         group: 'Lined Pages' },
            { value: 'lined-narrow',  label: 'Lined — Narrow Rule',          group: 'Lined Pages' },
        ];
        const groups = {};
        styleOptions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.value; opt.textContent = s.label;
            if (!s.group) {
                styleSelect.appendChild(opt);
            } else {
                if (!groups[s.group]) {
                    groups[s.group] = document.createElement('optgroup');
                    groups[s.group].label = s.group;
                    styleSelect.appendChild(groups[s.group]);
                }
                groups[s.group].appendChild(opt);
            }
        });

        function selectType(type) {
            selectedType = type;
            bmpBtn.classList.toggle('active', type === 'bmp');
            txtBtn.classList.toggle('active', type === 'txt');
            styleSelect.style.display = type === 'bmp' ? '' : 'none';
        }
        bmpBtn.addEventListener('click', () => selectType('bmp'));
        txtBtn.addEventListener('click', () => selectType('txt'));

        typeRow.appendChild(bmpBtn);
        typeRow.appendChild(txtBtn);

        const formActions = document.createElement('div');
        formActions.className = 'add-page-form-actions';

        const okBtn = document.createElement('button');
        okBtn.className = 'btn-primary';
        okBtn.textContent = 'Add';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-text';
        cancelBtn.textContent = 'Cancel';

        formActions.appendChild(okBtn);
        formActions.appendChild(cancelBtn);
        form.appendChild(nameInput);
        form.appendChild(typeRow);
        form.appendChild(styleSelect);
        form.appendChild(formActions);
        addRow.appendChild(form);
        nameInput.focus();
        nameInput.select();

        cancelBtn.addEventListener('click', () => {
            addRow.removeChild(form);
            addBtn.style.display = '';
        });

        async function submit() {
            const name  = nameInput.value.trim() || 'Untitled';
            const type  = selectedType;
            const style = type === 'bmp' ? styleSelect.value : 'default';
            const resp  = await fetch(`/api/notebooks/${nb.id}/pages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, type, style }),
            });
            if (resp.ok) {
                const page = await resp.json();
                location.href = `/notebooks/${nb.id}/pages/${page.id}`;
            }
        }

        okBtn.addEventListener('click', submit);
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }

    async function loadSidebar() {
        if (!listEl) return;
        try {
            const r = await fetch('/api/sidebar');
            if (!r.ok) return;
            const notebooks = await r.json();
            listEl.innerHTML = '';
            if (notebooks.length === 0) {
                listEl.innerHTML = '<span class="sidebar-loading">No notebooks yet.</span>';
                return;
            }
            notebooks.forEach(nb => {
                if (!(nb.id in collapseState)) collapseState[nb.id] = true;
                listEl.appendChild(renderNotebook(nb));
            });
        } catch (e) { /* not logged in or error */ }
    }

    // ── Recent pages grid (home page) ─────────────────────────────────────────
    async function loadRecentPages() {
        const grid = document.getElementById('recentGrid');
        if (!grid) return;
        try {
            const r = await fetch('/api/recent');
            if (!r.ok) return;
            const pages = await r.json();
            grid.innerHTML = '';
            if (pages.length === 0) {
                grid.innerHTML = '<span class="recent-empty">No pages opened yet. Open a canvas page to see it here.</span>';
                return;
            }
            pages.forEach(p => {
                const card = document.createElement('a');
                card.className = 'recent-card';
                card.href = `/notebooks/${p.notebookId}/pages/${p.pageId}`;
                card.innerHTML = `
                    <div class="recent-thumb">
                        <img src="/api/pages/${p.pageId}/content?type=bmp" alt="" loading="lazy" />
                    </div>
                    <div class="recent-info">
                        <span class="recent-page-name">${p.pageName}</span>
                        <span class="recent-nb-name">${p.notebookName}</span>
                    </div>`;
                grid.appendChild(card);
            });
        } catch (e) { /* not logged in */ }
    }

    // ── New Notebook ──────────────────────────────────────────────────────────
    const newNbBtn = document.getElementById('newNotebookBtn');
    if (newNbBtn) {
        newNbBtn.addEventListener('click', async () => {
            const name = await prompt('Notebook name:', 'Untitled Notebook');
            if (!name) return;
            const resp = await fetch('/api/notebooks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (resp.ok) loadSidebar();
        });
    }

    loadSidebar();
    loadRecentPages();
})();
