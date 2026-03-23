'use client';
import { useSession, signIn, signOut } from 'next-auth/react';
import { useState, useEffect } from 'react';

type NippouData = { toggl: string[]; calendar: string[] };
type Step = 'loading' | 'login' | 'setup_toggl' | 'setup_slack' | 'ready';

export default function Home() {
  const { data: session, status } = useSession();
  const [step, setStep] = useState<Step>('loading');
  const [togglInput, setTogglInput] = useState('');
  const [nippouData, setNippouData] = useState<NippouData | null>(null);
  const [hitokoto, setHitokoto] = useState('');
  const [fetching, setFetching] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (status === 'unauthenticated') { setStep('login'); return; }
    if (status !== 'authenticated') return;

    (async () => {
      const togglRes = await fetch('/api/toggl-token');
      const togglData = await togglRes.json();
      if (!togglData.token) { setStep('setup_toggl'); return; }

      const slackRes = await fetch('/api/slack/status');
      const slackData = await slackRes.json();
      if (!slackData.connected) { setStep('setup_slack'); return; }

      setStep('ready');
    })();
  }, [status]);

  async function saveTogglToken() {
    if (!togglInput.trim()) return;
    await fetch('/api/toggl-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: togglInput.trim() }),
    });
    setStep('setup_slack');
  }

  async function fetchNippou() {
    setFetching(true);
    setError('');
    setPosted(false);
    try {
      const res = await fetch('/api/nippou');
      const data = await res.json();
      setNippouData(data);
    } catch {
      setError('データの取得に失敗しました');
    } finally {
      setFetching(false);
    }
  }

  async function postToSlack() {
    if (!nippouData) return;
    setPosting(true);
    setError('');

    const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });

    const message = `*日報 ${today}*\n\n*やったこと*\n${nippouData.toggl.join('\n')}\n\n*やること（${tomorrowStr}）*\n${nippouData.calendar.join('\n')}\n\n*ひとこと*\n${hitokoto}`;

    try {
      const res = await fetch('/api/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (data.ok) { setPosted(true); setNippouData(null); setHitokoto(''); }
      else setError(`投稿失敗: ${data.error}`);
    } catch {
      setError('投稿に失敗しました');
    } finally {
      setPosting(false);
    }
  }

  if (step === 'loading') {
    return <div className="flex items-center justify-center min-h-screen text-gray-500">読み込み中...</div>;
  }

  if (step === 'login') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-white rounded-2xl shadow p-10 text-center max-w-sm w-full">
          <h1 className="text-2xl font-bold mb-2">日報ボット</h1>
          <p className="text-gray-500 mb-8 text-sm">Toggl + Googleカレンダーで日報を自動作成</p>
          <button
            onClick={() => signIn('google')}
            className="w-full flex items-center justify-center gap-3 border border-gray-300 rounded-lg py-3 px-4 hover:bg-gray-50 transition font-medium"
          >
            <svg viewBox="0 0 48 48" className="w-5 h-5"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.34-8.16 2.34-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Googleでログイン
          </button>
        </div>
      </div>
    );
  }

  if (step === 'setup_toggl') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-white rounded-2xl shadow p-10 max-w-sm w-full">
          <h2 className="text-xl font-bold mb-1">Toggl APIキーを設定</h2>
          <p className="text-gray-500 text-sm mb-6">Toggl Track → 設定 → Profile → API token</p>
          <input
            type="password"
            value={togglInput}
            onChange={e => setTogglInput(e.target.value)}
            placeholder="APIキーを貼り付け"
            className="w-full border rounded-lg px-4 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={saveTogglToken}
            className="w-full bg-blue-600 text-white rounded-lg py-2 font-medium hover:bg-blue-700 transition"
          >
            保存して次へ
          </button>
        </div>
      </div>
    );
  }

  if (step === 'setup_slack') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-white rounded-2xl shadow p-10 max-w-sm w-full text-center">
          <h2 className="text-xl font-bold mb-1">Slackと連携</h2>
          <p className="text-gray-500 text-sm mb-8">自分のアカウントで日報を投稿します</p>
          <a
            href="/api/slack/connect"
            className="w-full flex items-center justify-center gap-2 bg-[#4A154B] text-white rounded-lg py-3 px-4 font-medium hover:bg-[#3a1139] transition"
          >
            <svg viewBox="0 0 54 54" className="w-5 h-5 fill-white"><path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386"/><path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387"/><path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386"/><path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387"/></svg>
            Slackと連携する
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">日報ボット</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{session?.user?.email}</span>
          <button onClick={() => signOut()} className="text-sm text-gray-400 hover:text-gray-600">ログアウト</button>
        </div>
      </div>

      {posted && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 text-green-800 text-sm">
          Slackに投稿しました！
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-800 text-sm">{error}</div>
      )}

      {!nippouData ? (
        <button
          onClick={fetchNippou}
          disabled={fetching}
          className="w-full bg-blue-600 text-white rounded-xl py-4 text-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {fetching ? 'データ取得中...' : '日報を作成する'}
        </button>
      ) : (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <h2 className="font-semibold mb-3 text-gray-700">やったこと</h2>
            <div className="text-sm text-gray-600 space-y-1">
              {nippouData.toggl.map((line, i) => <p key={i}>{line}</p>)}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border p-6">
            <h2 className="font-semibold mb-3 text-gray-700">やること（明日）</h2>
            <div className="text-sm text-gray-600 space-y-1">
              {nippouData.calendar.map((line, i) => <p key={i}>{line}</p>)}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border p-6">
            <h2 className="font-semibold mb-3 text-gray-700">ひとこと</h2>
            <textarea
              value={hitokoto}
              onChange={e => setHitokoto(e.target.value)}
              placeholder="今日の一言を入力..."
              rows={3}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setNippouData(null)}
              className="flex-1 border border-gray-300 rounded-xl py-3 font-medium hover:bg-gray-50 transition"
            >
              やり直す
            </button>
            <button
              onClick={postToSlack}
              disabled={posting || !hitokoto.trim()}
              className="flex-1 bg-[#4A154B] text-white rounded-xl py-3 font-medium hover:bg-[#3a1139] disabled:opacity-50 transition"
            >
              {posting ? '投稿中...' : 'Slackに投稿'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
