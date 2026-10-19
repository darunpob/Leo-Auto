
(function(){
  const overlay = document.getElementById('fancyOverlay');
  const titleEl = document.getElementById('fancyTitle');
  const msgEl   = document.getElementById('fancyMessage');
  const inputEl = document.getElementById('fancyInput');
  const btnRow  = document.getElementById('fancyBtnRow');

  const ICONS = { info:'ℹ️', warn:'⚠️', error:'❌', success:'✅', confirm:'🗑️', prompt:'✏️' };

  function openDialog({ title, message, type='info', showInput=false, inputDefault='', inputPlaceholder='', buttons=[] }) {
    titleEl.textContent = title || (type === 'confirm' ? 'ยืนยัน' : type === 'prompt' ? 'กรอกข้อมูล' : 'แจ้งเตือน');
    // clean message — strip leading emoji duplicates like ⚠️ ❌
    const cleaned = (message || '').replace(/^[⚠️❌✅ℹ️🗑️✏️\s]+/, m => m.trim().replace(/^[⚠️❌✅ℹ️🗑️✏️]+/, '').trimStart());
    msgEl.textContent = cleaned || message;
    inputEl.style.display = showInput ? 'block' : 'none';
    if (showInput) { inputEl.value = inputDefault; inputEl.placeholder = inputPlaceholder; }
    btnRow.innerHTML = '';
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'fancy-prompt-btn' + (b.primary ? ' primary' : '');
      btn.textContent = b.label;
      btn.onclick = b.onClick;
      btnRow.appendChild(btn);
    });
    overlay.classList.add('open');
    if (showInput) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 80);
  }

  function close() { overlay.classList.remove('open'); }

  // Close on overlay click (outside box)
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  window.fancyAlert = function(message, type='info') {
    return new Promise(resolve => {
      openDialog({
        message, type,
        buttons: [{ label: 'ตกลง', primary: true, onClick: () => { close(); resolve(); } }]
      });
    });
  };

  window.fancyConfirm = function(message, type='confirm') {
    return new Promise(resolve => {
      openDialog({
        message, type,
        buttons: [
          { label: 'Cancel', onClick: () => { close(); resolve(false); } },
          { label: 'OK', primary: true, onClick: () => { close(); resolve(true); } }
        ]
      });
    });
  };

  window.fancyPrompt = function(message, defaultValue='') {
    return new Promise(resolve => {
      function submit() { close(); resolve(inputEl.value); }
      inputEl.onkeydown = e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { close(); resolve(null); } };
      openDialog({
        message, type: 'prompt', showInput: true, inputDefault: defaultValue,
        buttons: [
          { label: 'Cancel', onClick: () => { close(); resolve(null); } },
          { label: 'OK', primary: true, onClick: submit }
        ]
      });
    });
  };
})();
