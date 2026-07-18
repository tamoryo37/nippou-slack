(function () {
  'use strict';

  // --- Auth ---
  var params = new URLSearchParams(location.search);
  var token = params.get('token');
  var isPreview = params.get('preview') === '1';

  if (!token && !isPreview) {
    document.body.innerHTML = '<div style="padding:60px;text-align:center;color:#86868b;">' +
      '<p>Slack で <code>/nippou settings</code> を実行してリンクを取得してください。</p></div>';
    return;
  }

  var headers = { Authorization: 'Bearer ' + (token || ''), 'Content-Type': 'application/json' };

  // --- DOM refs ---
  const presetInputs = document.querySelectorAll('input[name="preset"]');
  const customPrompt = document.getElementById('customPrompt');
  const examplesContainer = document.getElementById('examples');
  const addExampleBtn = document.getElementById('addExampleBtn');
  const previewBtn = document.getElementById('previewBtn');
  const previewArea = document.getElementById('previewArea');
  const previewContent = document.getElementById('previewContent');
  const togglToken = document.getElementById('togglToken');
  const togglToggle = document.getElementById('togglToggle');
  const togglStatus = document.getElementById('togglStatus');
  const googleStatus = document.getElementById('googleStatus');
  const googleAccounts = document.getElementById('googleAccounts');
  const googleConnectBtn = document.getElementById('googleConnectBtn');
  const saveBar = document.getElementById('saveBar');
  const saveBtn = document.getElementById('saveBtn');
  const saveHint = document.getElementById('saveHint');
  const toast = document.getElementById('toast');

  let dirty = false;
  let originalData = {};
  let exampleCount = 0;

  // --- Dirty tracking ---
  function markDirty() {
    if (!dirty) {
      dirty = true;
      saveBar.classList.add('visible');
      saveHint.textContent = '未保存の変更があります';
    }
  }

  function markClean() {
    dirty = false;
    saveBar.classList.remove('visible');
  }

  // --- Toast ---
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2500);
  }

  // --- Examples ---
  function addExample(text) {
    exampleCount++;
    var idx = exampleCount;
    var item = document.createElement('div');
    item.className = 'example-item';
    item.innerHTML =
      '<div class="example-header">' +
        '<span class="example-label">お手本 ' + idx + '</span>' +
        '<button type="button" class="btn-danger-text remove-example">削除</button>' +
      '</div>' +
      '<textarea class="example-textarea" placeholder="理想の日報を貼り付けてください"></textarea>';
    var ta = item.querySelector('textarea');
    if (text) ta.value = text;
    ta.addEventListener('input', markDirty);
    item.querySelector('.remove-example').addEventListener('click', function () {
      item.remove();
      markDirty();
      renumberExamples();
    });
    examplesContainer.appendChild(item);
  }

  function renumberExamples() {
    var labels = examplesContainer.querySelectorAll('.example-label');
    labels.forEach(function (label, i) {
      label.textContent = 'お手本 ' + (i + 1);
    });
  }

  function getExamples() {
    var result = [];
    examplesContainer.querySelectorAll('.example-textarea').forEach(function (ta) {
      var val = ta.value.trim();
      if (val) result.push(val);
    });
    return result;
  }

  // --- Toggl toggle ---
  togglToggle.addEventListener('click', function () {
    var isPassword = togglToken.type === 'password';
    togglToken.type = isPassword ? 'text' : 'password';
    document.getElementById('togglEye').textContent = isPassword ? '🙈' : '👁';
  });

  // --- Load settings ---
  function loadSettings() {
    // Preview mode: use dummy data
    if (isPreview) {
      handleLoadedData({
        togglToken: '',
        ai: { preset: 'concise', customPrompt: '', examples: [] },
        googleAccounts: [],
        googleAuthUrl: '#',
      });
      return;
    }

    fetch('/api/settings', { headers: headers })
      .then(function (res) {
        if (!res.ok) throw new Error('Unauthorized');
        return res.json();
      })
      .then(function (data) {
        handleLoadedData(data);
      })
      .catch(function () {
        document.body.innerHTML = '<div style="padding:60px;text-align:center;color:#86868b;">' +
          '<p>リンクの有効期限が切れました。</p>' +
          '<p>Slack で <code>/nippou settings</code> を再実行してください。</p></div>';
      });
  }

  function handleLoadedData(data) {
    originalData = data;

    // Preset
    var preset = (data.ai && data.ai.preset) || 'concise';
    presetInputs.forEach(function (input) {
      input.checked = input.value === preset;
    });

    // Custom prompt
    customPrompt.value = (data.ai && data.ai.customPrompt) || '';

    // Examples
    var examples = (data.ai && data.ai.examples) || [];
    examples.forEach(function (ex) { addExample(ex); });

    // Toggl
    if (data.togglToken) {
      togglToken.value = data.togglToken;
      togglStatus.textContent = '設定済み';
      togglStatus.className = 'conn-status connected';
    } else {
      togglStatus.textContent = '未設定';
      togglStatus.className = 'conn-status';
    }

    // Google
    var gAccounts = data.googleAccounts || [];
    if (gAccounts.length > 0) {
      googleStatus.textContent = gAccounts.length + '件 連携済み';
      googleStatus.className = 'conn-status connected';
      gAccounts.forEach(function (acc) {
        var div = document.createElement('div');
        div.className = 'google-account';
        div.innerHTML = '<span class="google-account-email">' + acc.email + '</span>';
        googleAccounts.appendChild(div);
      });
    } else {
      googleStatus.textContent = '未連携';
      googleStatus.className = 'conn-status';
    }

    // Google connect link
    if (data.googleAuthUrl) {
      googleConnectBtn.href = data.googleAuthUrl;
    }
  }

  // --- Save ---
  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';

    var preset = 'concise';
    presetInputs.forEach(function (input) {
      if (input.checked) preset = input.value;
    });

    var body = {
      togglToken: togglToken.value.trim(),
      ai: {
        preset: preset,
        customPrompt: customPrompt.value.trim(),
        examples: getExamples(),
      },
    };

    fetch('/api/settings', { method: 'PUT', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) throw new Error('Save failed');
        return res.json();
      })
      .then(function () {
        showToast('保存しました');
        markClean();

        // Update Toggl status
        if (body.togglToken) {
          togglStatus.textContent = '設定済み';
          togglStatus.className = 'conn-status connected';
        } else {
          togglStatus.textContent = '未設定';
          togglStatus.className = 'conn-status';
        }
      })
      .catch(function () {
        showToast('保存に失敗しました');
      })
      .finally(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存する';
      });
  });

  // --- Preview ---
  previewBtn.addEventListener('click', function () {
    previewArea.classList.remove('hidden');
    previewArea.classList.add('loading');
    previewContent.textContent = '生成中';

    var preset = 'concise';
    presetInputs.forEach(function (input) {
      if (input.checked) preset = input.value;
    });

    var body = {
      ai: {
        preset: preset,
        customPrompt: customPrompt.value.trim(),
        examples: getExamples(),
      },
    };

    fetch('/api/preview', { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        if (!res.ok) throw new Error('Preview failed');
        return res.json();
      })
      .then(function (data) {
        previewContent.textContent = data.text;
        previewArea.classList.remove('loading');
      })
      .catch(function () {
        previewContent.textContent = 'プレビューの生成に失敗しました。ANTHROPIC_API_KEY が設定されているか確認してください。';
        previewArea.classList.remove('loading');
      });
  });

  // --- Event listeners ---
  presetInputs.forEach(function (input) { input.addEventListener('change', markDirty); });
  customPrompt.addEventListener('input', markDirty);
  togglToken.addEventListener('input', markDirty);
  addExampleBtn.addEventListener('click', function () { addExample(''); markDirty(); });

  // --- Init ---
  loadSettings();
})();
