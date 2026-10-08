import { useCallback, useEffect, useState } from 'react';
import './ManagerApiPanel.css';

type Endpoint = { method: string; path: string; scope: string };
type Certificate = { id: string; domain: string; certificatePath: string; privateKeyPath: string; advertiseHost?: string | null; advertisePort?: number | null; expiresAt?: string; error?: string };
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
  const [source, setSource] = useState(initialSource);
  const [editingId, setEditingId] = useState('');
  const [certificateId, setCertificateId] = useState('');
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
    setResult(''); setError(''); setNotice('');
    setCertificates([]); setEndpoints([]); setCertificateId(''); setEditingId(''); setSource(initialSource); setBusy(true);
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

  async function refresh() {
    const results = await Promise.all([
      request('GET', '/api/v1/catalog'), request('GET', '/api/v1/certificates'),
    ]);
    setEndpoints(results[0].data.endpoints); setCertificates(results[1].data);
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
    <p className="setting-description">まず証明書を検証して登録してください。GeyserはManager APIの管理トークンで接続できます。証明書の登録は各ボタンで即時保存されます。</p>
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
        setCertificateId(response.data.id); setEditingId(response.data.id); await refresh();
        setNotice(`証明書「${response.data.id}」（${response.data.domain}）を登録しました。`);
      })}>証明書を検証して登録</button>
      {certificates.map(certificate => <div className="manager-api-item" key={certificate.id}>
        <div><strong>{certificate.id}</strong> — {certificate.domain}<small>{certificate.error || `有効期限: ${certificate.expiresAt ? new Date(certificate.expiresAt).toLocaleString() : '不明'}`}</small></div>
        <button type="button" className="small-action-button" disabled={busy} onClick={() => act(async () => { await request('DELETE', `/api/v1/certificates/${encodeURIComponent(certificate.id)}`); await refresh(); })}>登録を削除</button>
      </div>)}
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
