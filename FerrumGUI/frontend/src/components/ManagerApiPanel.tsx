import { useCallback, useEffect, useState } from 'react';
import './ManagerApiPanel.css';

type Endpoint = { method: string; path: string; scope: string };
type Certificate = { id: string; domain: string; certificatePath: string; privateKeyPath: string; advertiseHost?: string | null; advertisePort?: number | null; expiresAt?: string; error?: string };
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

export function ManagerApiPanel({ instanceId, managerToken, copyText, onBusyChange }: {
  instanceId: string; managerToken?: string; copyText: (text: string) => Promise<void>; onBusyChange?: (busy: boolean) => void;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [source, setSource] = useState(initialSource);
  const [editingId, setEditingId] = useState('');
  const [certificateId, setCertificateId] = useState('');
  const [credentialName, setCredentialName] = useState('Geyser');
  const [expiresDays, setExpiresDays] = useState('');
  const [issuedToken, setIssuedToken] = useState('');
  const [issuedCertificate, setIssuedCertificate] = useState<{ id: string; domain: string } | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [endpoint, setEndpoint] = useState('GET /api/v1/health');
  const [resourceId, setResourceId] = useState('geyser');
  const [body, setBody] = useState('{}');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/manager`;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);

  const request = useCallback(async (method: string, path: string, payload?: unknown) => {
    const headers: Record<string, string> = {};
    if (managerToken) headers.Authorization = `Bearer ${managerToken}`;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, credentials: 'include', cache: 'no-store',
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error === 'Certificate scope must name a registered certificate'
      ? '選択した証明書IDが未登録です。「一覧を取得」で確認し、先に「証明書を検証して登録」を実行してください。'
      : data?.error || `HTTP ${response.status}`);
    return { status: response.status, data };
  }, [base, managerToken]);

  function selectSource(certificate?: Certificate) {
    setEditingId(certificate?.id || '');
    setSource(certificate ? {
      id: certificate.id, domain: certificate.domain,
      certificatePath: certificate.certificatePath, privateKeyPath: certificate.privateKeyPath,
      advertiseHost: certificate.advertiseHost || '', advertisePort: certificate.advertisePort == null ? '' : String(certificate.advertisePort),
    } : { ...initialSource, id: certificates.length ? '' : initialSource.id });
    if (certificate) setCertificateId(certificate.id);
  }

  function changeSource(key: keyof typeof initialSource, value: string) {
    setSource(previous => {
      const next = { ...previous, [key]: value };
      if (key === 'domain') {
        const oldDomain = previous.domain.trim().toLowerCase();
        const newDomain = value.trim().toLowerCase();
        const pathDomain = /^[a-z0-9.-]+$/.test(newDomain) ? newDomain : '';
        if (!previous.certificatePath || previous.certificatePath === `/etc/letsencrypt/live/${oldDomain}/fullchain.pem`)
          next.certificatePath = pathDomain ? `/etc/letsencrypt/live/${pathDomain}/fullchain.pem` : '';
        if (!previous.privateKeyPath || previous.privateKeyPath === `/etc/letsencrypt/live/${oldDomain}/privkey.pem`)
          next.privateKeyPath = pathDomain ? `/etc/letsencrypt/live/${pathDomain}/privkey.pem` : '';
      }
      return next;
    });
  }

  useEffect(() => {
    let active = true;
    setIssuedToken(''); setIssuedCertificate(null); setTokenVisible(false); setResult(''); setError(''); setNotice('');
    setCertificates([]); setCredentials([]); setEndpoints([]); setCertificateId(''); setEditingId(''); setSource(initialSource); setBusy(true);
    void request('GET', '/api/v1/certificates').then(({ data }: { data: Certificate[] }) => {
      if (!active) return;
      setCertificates(data);
      const first = data.find(item => item.id === 'geyser') || data[0];
      if (first) {
        setCertificateId(first.id); setEditingId(first.id);
        setSource({ id: first.id, domain: first.domain, certificatePath: first.certificatePath, privateKeyPath: first.privateKeyPath,
          advertiseHost: first.advertiseHost || '', advertisePort: first.advertisePort == null ? '' : String(first.advertisePort) });
      }
    }).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : '登録済み証明書を取得できませんでした');
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [request]);

  useEffect(() => { setIssuedToken(''); setIssuedCertificate(null); setTokenVisible(false); }, [certificateId]);
  async function refresh() {
    const results = await Promise.all([
      request('GET', '/api/v1/catalog'), request('GET', '/api/v1/certificates'), request('GET', '/api/v1/credentials'),
    ]);
    setEndpoints(results[0].data.endpoints); setCertificates(results[1].data); setCredentials(results[2].data);
    const next: Certificate[] = results[1].data;
    setCertificateId(current => next.some(item => item.id === current) ? current : next[0]?.id || '');
    setEditingId(current => next.some(item => item.id === current) ? current : '');
  }
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'APIリクエストに失敗しました'); }
    finally { setBusy(false); }
  }

  return <div className="manager-workspace">
    <div className="manager-workspace-heading"><strong>API・Geyser証明書連携</strong>
      <button type="button" className="small-action-button" disabled={busy} onClick={() => act(refresh)}>一覧を取得</button></div>
    <p className="setting-description">まず証明書を検証して登録してください。GeyserはManager APIの管理トークンで接続できます。証明書の取得だけを許可する拡張用トークンも発行できます。証明書の登録・トークン発行は、各ボタンで即時保存されます。</p>
    {error && <p className="manager-api-error" role="alert">{error}</p>}
    {notice && <p className="manager-api-notice" role="status">{notice}</p>}
    <details open><summary>配布する証明書</summary>
      <p className="setting-description">FerrumProxyが動くサーバー上の証明書パスを登録します。取得のたびに元のファイルを読み、証明書の更新を拡張へ届けます。</p>
      <label>登録済み証明書から選択<select value={editingId} disabled={busy} onChange={event => selectSource(certificates.find(item => item.id === event.target.value))}>
        <option value="">新しい証明書を登録</option>
        {certificates.map(certificate => <option key={certificate.id} value={certificate.id}>{certificate.id} — {certificate.domain}</option>)}
      </select></label>
      <div className="manager-api-fields">
        {([['id', '証明書ID'], ['domain', '接続ドメイン'], ['certificatePath', '証明書パス'], ['privateKeyPath', '秘密鍵パス'], ['advertiseHost', '公開UDP IP'], ['advertisePort', '公開UDPポート']] as const).map(([key, label]) =>
          <label key={key}>{label}<input value={source[key]} disabled={busy} onChange={event => changeSource(key, event.target.value)} spellCheck={false} /></label>)}
      </div>
      <p className="setting-description">ドメインを変更すると、Certbotの標準パスを自動入力します。標準パス以外を手動指定した場合は、そのパスを保持します。実際のファイル・ドメイン・鍵の一致は登録時に検証します。</p>
      <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => {
        const payload = { ...source, id: source.id.trim(), domain: source.domain.trim(), certificatePath: source.certificatePath.trim(), privateKeyPath: source.privateKeyPath.trim(),
          advertiseHost: source.advertiseHost.trim() || null, advertisePort: source.advertisePort.trim() ? Number(source.advertisePort) : null };
        if (payload.advertisePort !== null && (!Number.isInteger(payload.advertisePort) || payload.advertisePort < 1 || payload.advertisePort > 65535))
          throw new Error('公開UDPポートは1〜65535の整数で指定してください');
        const response = await request('POST', '/api/v1/certificates', payload);
        setIssuedToken(''); setIssuedCertificate(null); setTokenVisible(false);
        setCertificateId(response.data.id); setEditingId(response.data.id); await refresh();
        setNotice(`証明書「${response.data.id}」（${response.data.domain}）を登録しました。次に拡張用トークンを発行できます。`);
      })}>証明書を検証して登録</button>
      {certificates.map(certificate => <div className="manager-api-item" key={certificate.id}>
        <div><strong>{certificate.id}</strong> — {certificate.domain}<small>{certificate.error || `有効期限: ${certificate.expiresAt ? new Date(certificate.expiresAt).toLocaleString() : '不明'}`}</small></div>
        <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => { await request('DELETE', `/api/v1/certificates/${encodeURIComponent(certificate.id)}`); await refresh(); })}>登録を削除</button>
      </div>)}
    </details>
    <details><summary>Geyser拡張の認証</summary>
      <p className="setting-description">管理トークンを使う場合は、Manager API画面のトークンを manager-token.txt に保存します。以下の拡張用トークンは指定した証明書の取得専用で、GET /api/v1/health は許可しません。接続確認には GET /api/v1/certificates/証明書ID を使います。</p>
      <div className="manager-api-fields">
        <label>名前<input value={credentialName} onChange={event => setCredentialName(event.target.value)} /></label>
        <label>取得を許可する登録済み証明書<select value={certificateId} disabled={busy || certificates.length === 0} onChange={event => setCertificateId(event.target.value)}>
          {certificates.length === 0 && <option value="">先に証明書を登録してください</option>}
          {certificates.map(certificate => <option key={certificate.id} value={certificate.id}>{certificate.id} — {certificate.domain}</option>)}
        </select></label>
        <label>トークンの有効日数<input type="number" min="1" value={expiresDays} placeholder="空欄なら失効まで有効" onChange={event => setExpiresDays(event.target.value)} /></label>
      </div>
      {certificates.length === 0 && <p className="setting-description">証明書がまだ登録されていません。「配布する証明書」で登録してから発行してください。</p>}
      <button type="button" className="small-action-button" disabled={busy || !certificates.some(item => item.id === certificateId)} onClick={() => act(async () => {
        const certificate = certificates.find(item => item.id === certificateId);
        if (!certificate) throw new Error('先に証明書を登録してください');
        if (expiresDays && (!Number.isSafeInteger(Number(expiresDays)) || Number(expiresDays) < 1)) throw new Error('有効日数は1以上の整数で指定してください');
        const response = await request('POST', '/api/v1/credentials', { name: credentialName, scopes: [`certificates:read:${certificateId}`], expiresIn: expiresDays ? Number(expiresDays) * 86400 : null });
        setIssuedCertificate({ id: certificate.id, domain: certificate.domain }); setIssuedToken(response.data.token); setTokenVisible(false); await refresh();
      })}>拡張用トークンを発行</button>
      {issuedToken && <div className="manager-issued-token">
        <p>このトークンは再表示できません。拡張フォルダーの manager-token.txt に保存してください。</p>
        <input type={tokenVisible ? 'text' : 'password'} readOnly value={issuedToken} aria-label="発行した拡張用トークン" autoComplete="off" />
        <div className="manager-workspace-heading"><button type="button" className="small-action-button" onClick={() => setTokenVisible(!tokenVisible)}>{tokenVisible ? '隠す' : '表示'}</button>
          <button type="button" className="small-action-button" onClick={() => act(async () => { await copyText(issuedToken); })}>トークンをコピー</button>
          <button type="button" className="small-action-button" onClick={() => act(async () => {
            if (!issuedCertificate) throw new Error('拡張用トークンを発行してください');
            await copyText(`enabled: true\nmanager-url: '${window.location.origin}${base}'\ntoken-file: manager-token.txt\ncertificate-id: '${issuedCertificate.id.replaceAll("'", "''")}'\ndomain: '${issuedCertificate.domain.replaceAll("'", "''")}'\npoll-seconds: 300\nauto-reload: true\nallow-insecure-http: false\n`);
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
