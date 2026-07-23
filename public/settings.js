(function () {
  'use strict';

  // --- Auth ---
  var params = new URLSearchParams(location.search);
  var token = params.get('token');
  var isPreview = params.get('preview') === '1';
  var notionResult = params.get('notion');

  // 署名付きトークンをブラウザ履歴・共有URL・Refererへ残さない。
  if (token && window.history && window.history.replaceState) {
    window.history.replaceState(null, document.title, location.pathname + location.hash);
  }

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
  const taskStatus = document.getElementById('taskStatus');
  const notionStatus = document.getElementById('notionStatus');
  const notionEnabled = document.getElementById('notionEnabled');
  const notionConnectBtn = document.getElementById('notionConnectBtn');
  const notionDisconnectBtn = document.getElementById('notionDisconnectBtn');
  const notionDatabaseUrl = document.getElementById('notionDatabaseUrl');
  const notionTestBtn = document.getElementById('notionTestBtn');
  const notionTestResult = document.getElementById('notionTestResult');
  const jsonStatus = document.getElementById('jsonStatus');
  const jsonEnabled = document.getElementById('jsonEnabled');
  const jsonName = document.getElementById('jsonName');
  const jsonUrl = document.getElementById('jsonUrl');
  const jsonBearerToken = document.getElementById('jsonBearerToken');
  const jsonTestBtn = document.getElementById('jsonTestBtn');
  const jsonTestResult = document.getElementById('jsonTestResult');
  const saveBar = document.getElementById('saveBar');
  const saveBtn = document.getElementById('saveBtn');
  const saveHint = document.getElementById('saveHint');
  const toast = document.getElementById('toast');

  let dirty = false;
  let originalData = {};
  let exampleCount = 0;

  const notionMappingFields = {
    title: document.getElementById('notionTitleProperty'),
    status: document.getElementById('notionStatusProperty'),
    completedStatus: document.getElementById('notionDoneStatus'),
    scheduledDate: document.getElementById('notionScheduledProperty'),
    dueDate: document.getElementById('notionDueProperty'),
    completedAt: document.getElementById('notionCompletedProperty'),
    category: document.getElementById('notionCategoryProperty'),
    workCategory: document.getElementById('notionWorkValue'),
    reportable: document.getElementById('notionReportableProperty'),
    confidentiality: document.getElementById('notionSensitivityProperty'),
    excludedConfidentiality: document.getElementById('notionExcludedSensitivity'),
  };

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
        notionAuthUrl: '#',
        taskSources: {
          notion: { available: true, connected: false, enabled: false, mapping: {} },
          json: { enabled: false, hasBearerToken: false },
        },
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

    // Optional task sources
    var sources = data.taskSources || {};
    var notion = sources.notion || {};
    var json = sources.json || {};

    notionEnabled.checked = Boolean(notion.enabled);
    notionEnabled.disabled = !notion.connected;
    notionDatabaseUrl.value = notion.databaseUrl || '';
    Object.keys(notionMappingFields).forEach(function (key) {
      if (notion.mapping && typeof notion.mapping[key] === 'string') {
        notionMappingFields[key].value = notion.mapping[key];
      }
    });

    if (notion.connected) {
      notionStatus.textContent = notion.workspaceName
        ? notion.workspaceName + ' に接続済み'
        : '接続済み';
      notionStatus.className = 'conn-status connected';
      notionConnectBtn.textContent = '接続し直す';
      notionDisconnectBtn.classList.remove('hidden');
    } else if (!notion.available) {
      notionStatus.textContent = 'アプリ側のNotion設定待ち';
      notionStatus.className = 'conn-status';
      notionConnectBtn.classList.add('hidden');
    } else {
      notionStatus.textContent = '未接続';
      notionStatus.className = 'conn-status';
    }
    if (data.notionAuthUrl) notionConnectBtn.href = data.notionAuthUrl;

    jsonEnabled.checked = Boolean(json.enabled);
    jsonName.value = json.name || '';
    jsonUrl.value = json.url || '';
    jsonStatus.textContent = json.url
      ? (json.hasBearerToken ? 'URL・認証設定済み' : 'URL設定済み')
      : '未設定';
    jsonStatus.className = json.url ? 'conn-status connected' : 'conn-status';

    updateTaskStatus();

    if (notionResult === 'connected') {
      showToast('Notionを接続しました');
      location.hash = 'taskSources';
    } else if (notionResult === 'error') {
      showToast('Notionの接続に失敗しました');
      location.hash = 'taskSources';
    }
  }

  function updateTaskStatus() {
    var count = 0;
    if (notionEnabled.checked && !notionEnabled.disabled) count++;
    if (jsonEnabled.checked && jsonUrl.value.trim()) count++;
    taskStatus.textContent = count > 0 ? count + '件 使用中' : '未設定';
    taskStatus.className = count > 0 ? 'conn-status connected' : 'conn-status';
  }

  function getNotionMapping() {
    var mapping = {};
    Object.keys(notionMappingFields).forEach(function (key) {
      mapping[key] = notionMappingFields[key].value.trim();
    });
    return mapping;
  }

  function getTaskSourcesBody() {
    return {
      notion: {
        enabled: notionEnabled.checked,
        databaseUrl: notionDatabaseUrl.value.trim(),
        mapping: getNotionMapping(),
      },
      json: {
        enabled: jsonEnabled.checked,
        name: jsonName.value.trim(),
        url: jsonUrl.value.trim(),
        bearerToken: jsonBearerToken.value,
      },
    };
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
      taskSources: getTaskSourcesBody(),
    };

    fetch('/api/settings', { method: 'PUT', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || '保存に失敗しました');
          return data;
        });
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
        jsonBearerToken.value = '';
        updateTaskStatus();
      })
      .catch(function (error) {
        showToast(error.message || '保存に失敗しました');
      })
      .finally(function () {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存する';
      });
  });

  function showTestResult(element, message, ok) {
    element.textContent = message;
    element.classList.remove('hidden', 'success', 'error');
    element.classList.add(ok ? 'success' : 'error');
  }

  function testTaskSource(provider, button, resultElement) {
    button.disabled = true;
    var previousText = button.textContent;
    button.textContent = '確認中...';
    var config = provider === 'notion'
      ? getTaskSourcesBody().notion
      : getTaskSourcesBody().json;

    fetch('/api/task-sources/test', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ provider: provider, config: config }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || '接続を確認できませんでした');
          return data;
        });
      })
      .then(function (data) {
        var lines = ['接続できました'];
        if (data.done && data.done.length) lines.push('やったこと: ' + data.done.join(' / '));
        if (data.will && data.will.length) lines.push('やること: ' + data.will.join(' / '));
        if ((!data.done || !data.done.length) && (!data.will || !data.will.length)) {
          lines.push('対象期間のタスクは0件です');
        }
        showTestResult(resultElement, lines.join('\n'), true);
      })
      .catch(function (error) {
        showTestResult(resultElement, error.message, false);
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = previousText;
      });
  }

  notionTestBtn.addEventListener('click', function () {
    testTaskSource('notion', notionTestBtn, notionTestResult);
  });
  jsonTestBtn.addEventListener('click', function () {
    testTaskSource('json', jsonTestBtn, jsonTestResult);
  });

  notionDisconnectBtn.addEventListener('click', function () {
    if (!window.confirm('Notionとの接続を解除しますか？')) return;
    notionDisconnectBtn.disabled = true;
    fetch('/api/task-sources/notion/disconnect', { method: 'POST', headers: headers })
      .then(function (res) {
        if (!res.ok) throw new Error('解除に失敗しました');
        notionStatus.textContent = '未接続';
        notionStatus.className = 'conn-status';
        notionEnabled.checked = false;
        notionEnabled.disabled = true;
        notionDisconnectBtn.classList.add('hidden');
        notionConnectBtn.textContent = 'Notionを接続';
        showToast('Notionの接続を解除しました');
        updateTaskStatus();
      })
      .catch(function () {
        showToast('Notionの接続解除に失敗しました');
      })
      .finally(function () {
        notionDisconnectBtn.disabled = false;
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
  notionEnabled.addEventListener('change', function () { markDirty(); updateTaskStatus(); });
  notionDatabaseUrl.addEventListener('input', markDirty);
  Object.keys(notionMappingFields).forEach(function (key) {
    notionMappingFields[key].addEventListener('input', markDirty);
  });
  jsonEnabled.addEventListener('change', function () { markDirty(); updateTaskStatus(); });
  jsonName.addEventListener('input', markDirty);
  jsonUrl.addEventListener('input', function () { markDirty(); updateTaskStatus(); });
  jsonBearerToken.addEventListener('input', markDirty);
  addExampleBtn.addEventListener('click', function () { addExample(''); markDirty(); });

  // --- Init ---
  loadSettings();
})();
