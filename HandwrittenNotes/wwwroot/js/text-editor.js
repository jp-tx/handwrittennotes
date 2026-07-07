(function () {
    'use strict';

    const ta = document.getElementById('textEditor');
    if (!ta) return;

    const pageId = ta.dataset.pageId;
    const indicator = document.getElementById('saveIndicator');
    let saveTimer = null;
    let dirty = false;

    async function loadContent() {
        const r = await fetch(`/api/pages/${pageId}/content?type=txt`);
        if (r.ok) ta.value = await r.text();
        ta.focus();
    }

    function setIndicator(state, text) {
        indicator.textContent = text;
        indicator.className = 'save-indicator ' + state;
    }

    async function save() {
        if (!dirty) return;
        setIndicator('saving', 'Saving…');
        try {
            const r = await fetch(`/api/pages/${pageId}/content?type=txt`, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/plain' },
                body: ta.value
            });
            setIndicator(r.ok ? 'saved' : 'error', r.ok ? 'Saved' : 'Error');
            if (r.ok) dirty = false;
        } catch {
            setIndicator('error', 'Error');
        }
        setTimeout(() => { indicator.textContent = ''; indicator.className = 'save-indicator'; }, 2000);
    }

    ta.addEventListener('input', () => {
        dirty = true;
        setIndicator('saving', 'Unsaved');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 1000);
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            clearTimeout(saveTimer);
            save();
        }
    });

    window.addEventListener('beforeunload', (e) => {
        if (dirty) e.preventDefault();
    });

    loadContent();
})();
