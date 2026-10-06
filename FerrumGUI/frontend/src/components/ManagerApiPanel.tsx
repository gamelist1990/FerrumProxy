import { useEffect, useState } from 'react';
import './ManagerApiPanel.css';

type Endpoint = { method: string; path: string; scope: string };
type Certificate = { id: string; domain: string; expiresAt?: string; error?: string };
type Credential = { id: string; name: string; scopes: string[]; expiresAt?: string };
const initialSource = {
  id: 'geyser', domain: 'example.com',
  certificatePath: '/etc/letsencrypt/live/example.com/fullchain.pem',
  privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
  advertiseHost: '', advertisePort: '',
};

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, ['privateKeyPem', 'certificatePem', 'token', 'tokenHash'].includes(key) ? '[非表示]' : redact(item)]));
  return value;
}

export function ManagerApiPanel({ instanceId, managerToken, copyText }: {
  instanceId: string; managerToken?: string; copyText: (text: string) => Promise<void>;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [source, setSource] = useState(initialSource);
  const [certificateId, setCertificateId] = useState('geyser');
  const [credentialName, setCredentialName] = useState('Geyser');
  const [expiresDays, setExpiresDays] = useState('');
  const [issuedToken, setIssuedToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [endpoint, setEndpoint] = useState('GET /api/v1/health');
  const [resourceId, setResourceId] = useState('geyser');
  const [body, setBody] = useState('{}');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/manager`;

  useEffect(() => { setIssuedToken(''); setTokenVisible(false); setResult(''); setError(''); setCertificates([]); setCredentials([]); setEndpoints([]); }, [instanceId, managerToken]);

  async function request(method: string, path: string, payload?: unknown) {
    const headers: Record<string, string> = {};
    if (managerToken) headers.Authorization = `Bearer ${managerToken}`;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, credentials: 'include', cache: 'no-store',
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return { status: response.status, data };
  }
  async function refresh() {
    const results = await Promise.all([
      request('GET', '/api/v1/catalog'), request('GET', '/api/v1/certificates'), request('GET', '/api/v1/credentials'),
    ]);
    setEndpoints(results[0].data.endpoints); setCertificates(results[1].data); setCredentials(results[2].data);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'APIリクエストに失敗しました'); }
    finally { setBusy(false); }
  }

  return <div className="manager-workspace">
    <div className="manager-workspace-heading"><strong>API・Geyser証明書連携</strong>
      <button type="button" className="small-action-button" disabled={busy} onClick={() => act(refresh)}>一覧を取得</button></div>
    <p className="setting-description">Manager設定を保存し、インスタンスを起動してから利用できます。拡張用トークンには選んだ証明書の取得だけを許可します。</p>
    {error && <p className="manager-api-error" role="alert">{error}</p>}
    <details open><summary>配布する証明書</summary>
      <p className="setting-description">FerrumProxyが動くサーバー上の証明書パスを登録します。取得のたびに元のファイルを読み、証明書の更新を拡張へ届けます。</p>
      <div className="manager-api-fields">
        {([['id', '証明書ID'], ['domain', '接続ドメイン'], ['certificatePath', '証明書パス'], ['privateKeyPath', '秘密鍵パス'], ['advertiseHost', '公開UDP IP'], ['advertisePort', '公開UDPポート']] as const).map(([key, label]) =>
          <label key={key}>{label}<input value={source[key]} onChange={event => setSource({ ...source, [key]: event.target.value })} spellCheck={false} /></label>)}
      </div>
      <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => {
        const payload = { ...source, advertiseHost: source.advertiseHost.trim() || null, advertisePort: source.advertisePort.trim() ? Number(source.advertisePort) : null };
        await request('POST', '/api/v1/certificates', payload); setCertificateId(source.id); await refresh();
      })}>証明書を検証して登録</button>
      {certificates.map(certificate => <div className="manager-api-item" key={certificate.id}>
        <div><strong>{certificate.id}</strong> — {certificate.domain}<small>{certificate.error || `有効期限: ${certificate.expiresAt ? new Date(certificate.expiresAt).toLocaleString() : '不明'}`}</small></div>
        <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => { await request('DELETE', `/api/v1/certificates/${encodeURIComponent(certificate.id)}`); await refresh(); })}>登録を削除</button>
      </div>)}
    </details>
    <details><summary>Geyser拡張の認証</summary>
      <div className="manager-api-fields">
        <label>名前<input value={credentialName} onChange={event => setCredentialName(event.target.value)} /></label>
        <label>取得を許可する証明書ID<input value={certificateId} onChange={event => setCertificateId(event.target.value)} /></label>
        <label>トークンの有効日数<input type="number" min="1" value={expiresDays} placeholder="空欄なら失効まで有効" onChange={event => setExpiresDays(event.target.value)} /></label>
      </div>
      <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => {
        if (expiresDays && (!Number.isSafeInteger(Number(expiresDays)) || Number(expiresDays) < 1)) throw new Error('有効日数は1以上の整数で指定してください');
        const response = await request('POST', '/api/v1/credentials', { name: credentialName, scopes: [`certificates:read:${certificateId}`], expiresIn: expiresDays ? Number(expiresDays) * 86400 : null });
        setIssuedToken(response.data.token); setTokenVisible(false); await refresh();
      })}>拡張用トークンを発行</button>
      {issuedToken && <div className="manager-issued-token">
        <p>このトークンは再表示できません。拡張フォルダーの manager-token.txt に保存してください。</p>
        <input type={tokenVisible ? 'text' : 'password'} readOnly value={issuedToken} aria-label="発行した拡張用トークン" autoComplete="off" />
        <div className="manager-workspace-heading"><button type="button" className="small-action-button" onClick={() => setTokenVisible(!tokenVisible)}>{tokenVisible ? '隠す' : '表示'}</button>
          <button type="button" className="small-action-button" onClick={() => act(async () => { await copyText(issuedToken); })}>トークンをコピー</button>
          <button type="button" className="small-action-button" onClick={() => act(async () => {
            await copyText(`enabled: true\nmanager-url: '${window.location.origin}${base}'\ntoken-file: manager-token.txt\ncertificate-id: '${certificateId.replaceAll("'", "''")}'\ndomain: '${source.domain.replaceAll("'", "''")}'\npoll-seconds: 300\nauto-reload: true\nallow-insecure-http: false\n`);
          })}>拡張設定をコピー</button></div>
      </div>}
      {credentials.map(credential => <div className="manager-api-item" key={credential.id}><div><strong>{credential.name}</strong><small>{credential.scopes.join(', ')} / {credential.expiresAt || '失効まで有効'}</small></div>
        <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => { await request('DELETE', `/api/v1/credentials/${encodeURIComponent(credential.id)}`); await refresh(); })}>失効</button></div>)}
      <p className="setting-description">Manager APIへの接続にはHTTPS、またはTailscaleの100.xアドレスを使います。auto-reload が有効なら証明書更新時にGeyserを自動リロードします。接続中のBedrockプレイヤーは切断されます。</p>
    </details>
    <details><summary>APIを実行</summary>
      <label>操作<select value={endpoint} onChange={event => setEndpoint(event.target.value)}>
        {(endpoints.length ? endpoints : [{ method: 'GET', path: '/api/v1/health', scope: 'health:read' }]).map(item =>
          <option key={`${item.method} ${item.path}`} value={`${item.method} ${item.path}`}>{item.method} {item.path}</option>)}
      </select></label>
      {endpoint.includes('{id}') && <label>対象ID<input value={resourceId} onChange={event => setResourceId(event.target.value)} /></label>}
      {endpoint.startsWith('POST') && <label>JSON本文<textarea value={body} onChange={event => setBody(event.target.value)} rows={5} spellCheck={false} /></label>}
      <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => {
        const [method, path] = endpoint.split(' ');
        const response = await request(method, path.replace('{id}', encodeURIComponent(resourceId)), method === 'POST' ? JSON.parse(body) : undefined);
        setResult(JSON.stringify({ status: response.status, data: redact(response.data) }, null, 2));
      })}>{busy ? '処理中…' : '実行'}</button>
      {result && <pre className="manager-api-result" aria-live="polite">{result}</pre>}
    </details>
  </div>;
}
