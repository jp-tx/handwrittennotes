/* global sidebar + auth logic */
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

        const badge = document.createElement('span');
        badge.className = 'page-type-badge';
        badge.textContent = pg.type.toUpperCase();

        const name = document.createElement('span');
        name.className = 'page-name';
        name.textContent = pg.name;

        const actions = document.createElement('div');
        actions.className = 'page-actions';

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

        actions.appendChild(delBtn);
        item.appendChild(badge);
        item.appendChild(name);
        item.appendChild(actions);

        item.addEventListener('click', () => {
            location.href = `/notebooks/${nb.id}/pages/${pg.id}`;
        });

        name.addEventListener('dblclick', (e) => {
            e.stopPropagation();
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
                        body: JSON.stringify({ name: val })
                    });
                }
                loadSidebar();
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                if (ev.key === 'Escape') { input.removeEventListener('blur', commit); item.replaceChild(name, input); }
            });
        });

        return item;
    }

    function renderNotebook(nb) {
        const open = collapseState[nb.id] !== false;

        const section = document.createElement('div');
        section.className = 'nb-section';

        const header = document.createElement('div');
        header.className = 'nb-header';

        const toggle = document.createElement('span');
        toggle.className = 'nb-toggle' + (open ? ' open' : '');
        toggle.textContent = '▶';

        const nameEl = document.createElement('span');
        nameEl.className = 'nb-name';
        nameEl.textContent = nb.name;

        const actions = document.createElement('div');
        actions.className = 'nb-actions';

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

        actions.appendChild(delBtn);
        header.appendChild(toggle);
        header.appendChild(nameEl);
        header.appendChild(actions);
        section.appendChild(header);

        const pagesWrap = document.createElement('div');
        pagesWrap.className = 'nb-pages' + (open ? '' : ' hidden');

        nb.pages.forEach(pg => pagesWrap.appendChild(renderPage(nb, pg)));

        // Add page row
        const addRow = document.createElement('div');
        addRow.className = 'add-page-row';
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-add-page';
        addBtn.textContent = '+ Add page';
        addBtn.addEventListener('click', () => showAddPageForm(nb, addRow, addBtn));
        addRow.appendChild(addBtn);
        pagesWrap.appendChild(addRow);

        section.appendChild(pagesWrap);

        // Toggle collapse
        header.addEventListener('click', (e) => {
            if (e.target.closest('.nb-actions')) return;
            if (e.target === nameEl && nameEl.isContentEditable) return;
            const isOpen = !pagesWrap.classList.contains('hidden');
            pagesWrap.classList.toggle('hidden', isOpen);
            toggle.classList.toggle('open', !isOpen);
            collapseState[nb.id] = !isOpen;
        });

        // Rename on double-click
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
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
                        body: JSON.stringify({ name: val })
                    });
                }
                loadSidebar();
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                if (ev.key === 'Escape') { input.removeEventListener('blur', commit); header.replaceChild(nameEl, input); }
            });
        });

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

        function selectType(type) {
            selectedType = type;
            bmpBtn.classList.toggle('active', type === 'bmp');
            txtBtn.classList.toggle('active', type === 'txt');
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
        form.appendChild(formActions);
        addRow.appendChild(form);
        nameInput.focus();
        nameInput.select();

        cancelBtn.addEventListener('click', () => {
            addRow.removeChild(form);
            addBtn.style.display = '';
        });

        async function submit() {
            const name = nameInput.value.trim() || 'Untitled';
            const type = selectedType;
            const resp = await fetch(`/api/notebooks/${nb.id}/pages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, type })
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

    // ── New Notebook ──────────────────────────────────────────────────────────
    const newNbBtn = document.getElementById('newNotebookBtn');
    if (newNbBtn) {
        newNbBtn.addEventListener('click', async () => {
            const name = await prompt('Notebook name:', 'Untitled Notebook');
            if (!name) return;
            const resp = await fetch('/api/notebooks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (resp.ok) loadSidebar();
        });
    }

    loadSidebar();
})();
