import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, CheckCircle2, Copy, Eye, EyeOff, Fingerprint, GitBranch, KeyRound, LoaderCircle, RefreshCw, RotateCcw, Save, Server, Settings2, ShieldCheck, Zap } from 'lucide-react';
import type { FerrumProxyInstance } from '../api';
import { t } from '../lang';
import { ManagerApiPanel } from './ManagerApiPanel';
import { Switch } from './ui/Switch';
import './InstanceSettingsPage.css';

type Section = 'general' | 'automation' | 'manager' | 'certificates' | 'version';
type MetadataPatch = { name?: string; autoStart?: boolean; autoRestart?: boolean; managerPort?: number | null; managerToken?: string | null };
type Draft = { name: string; autoStart: boolean; autoRestart: boolean; managerToken: string };
const draftOf = (instance: FerrumProxyInstance): Draft => ({ name: instance.name, autoStart: !!instance.autoStart, autoRestart: !!instance.autoRestart, managerToken: instance.managerToken || '' });

export function InstanceSettingsPage({ instance, onBack, onOpenProxyConfig, onSaveMetadata, onUpdateInstance, availableVersions, latestVersion, isUpdating = false }: {
  instance: FerrumProxyInstance; onBack: () => void; onOpenProxyConfig: () => void;
  onSaveMetadata: (patch: MetadataPatch) => Promise<FerrumProxyInstance>;
  onUpdateInstance: (version: string, forceReinstall?: boolean) => Promise<void>;
  availableVersions: string[]; latestVersion: string; isUpdating?: boolean;
}) {
  const [section, setSection] = useState<Section>('general');
  const [draft, setDraft] = useState(() => draftOf(instance));
  const [baseline, setBaseline] = useState(() => draftOf(instance));
  const [saving, setSaving] = useState(false);
  const [apiBusy, setApiBusy] = useState(false);
  const [certificatesVisited, setCertificatesVisited] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('latest');
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [nameError, setNameError] = useState(false);
  const [copied, setCopied] = useState('');
  const title = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const normalized = { ...draft, name: draft.name.trim(), managerToken: draft.managerToken.trim() };
  const dirty = JSON.stringify(normalized) !== JSON.stringify(baseline);
  const managerChanged = normalized.managerToken !== baseline.managerToken;
  const busy = saving || apiBusy;
  const version = selectedVersion === 'latest' ? latestVersion : selectedVersion;
  const reinstall = version === instance.version;
  const tabs = [
    { id: 'general' as const, label: t('settingsGeneral'), description: t('settingsGeneralHint'), icon: Settings2 },
    { id: 'automation' as const, label: t('settingsAutomation'), description: t('settingsAutomationHint'), icon: Zap },
    { id: 'manager' as const, label: 'Manager API', description: t('settingsManagerHint'), icon: KeyRound },
    { id: 'certificates' as const, label: t('settingsCertificates'), description: t('settingsCertificatesHint'), icon: ShieldCheck },
    { id: 'version' as const, label: t('settingsVersion'), description: t('settingsVersionHint'), icon: RefreshCw },
  ];
  const active = tabs.find(item => item.id === section)!;

  useEffect(() => { title.current?.focus(); window.scrollTo({ top: 0 }); return () => window.clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    if (!dirty) return;
    const preventExit = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventExit);
    return () => window.removeEventListener('beforeunload', preventExit);
  }, [dirty]);

  function leave(action: () => void) {
    if (busy || (dirty && !window.confirm(t('settingsDiscardConfirm')))) return;
    action();
  }
  function navigate(next: Section) {
    if (next === 'certificates') setCertificatesVisited(true);
    setSection(next);
    requestAnimationFrame(() => content.current?.scrollIntoView({ block: 'start' }));
  }
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(previous => ({ ...previous, [key]: value })); setFeedback(null); }
  async function copyText(text: string) {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
    const textarea = document.createElement('textarea');
    textarea.value = text; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.left = '-9999px';
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.appendChild(textarea); textarea.select();
    const success = document.execCommand('copy'); textarea.remove(); previousFocus?.focus();
    if (!success) throw new Error(t('settingsCopyFailed'));
  }
  async function copy(text: string, id: string) {
    try { await copyText(text); setCopied(id); window.clearTimeout(copyTimer.current); copyTimer.current = window.setTimeout(() => setCopied(''), 1800); }
    catch { setFeedback({ error: true, text: t('settingsCopyFailed') }); }
  }
  async function save() {
    if (!normalized.name) { setNameError(true); navigate('general'); requestAnimationFrame(() => document.getElementById('instance-name')?.focus()); return; }
    setNameError(false); setSaving(true); setFeedback(null);
    try {
      const patch: MetadataPatch = {};
      if (normalized.name !== baseline.name) patch.name = normalized.name;
      if (draft.autoStart !== baseline.autoStart) patch.autoStart = draft.autoStart;
      if (draft.autoRestart !== baseline.autoRestart) patch.autoRestart = draft.autoRestart;
      if (managerChanged) { patch.managerToken = normalized.managerToken || null; patch.managerPort = normalized.managerToken ? instance.managerPort ?? null : null; }
      const updated = await onSaveMetadata(patch);
      setDraft(draftOf(updated)); setBaseline(draftOf(updated));
      setFeedback({ error: false, text: managerChanged ? t('settingsSavedRestart') : t('settingsSaved') });
    } catch (failure) { setFeedback({ error: true, text: `${t('errorSaveConfig')} ${failure instanceof Error ? failure.message : t('retryRequest')}` }); }
    finally { setSaving(false); }
  }
  function regenerateToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    edit('managerToken', btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
    setTokenVisible(true);
  }
  async function update() {
    if (!window.confirm(`${reinstall ? t('settingsReinstallConfirm') : t('settingsUpdateConfirm')} v${version}?`)) return;
    try { setFeedback(null); await onUpdateInstance(selectedVersion, reinstall); }
    catch (failure) { setFeedback({ error: true, text: failure instanceof Error ? failure.message : t('retryRequest') }); }
  }
  const managerUrl = `${window.location.origin}/api/instances/${encodeURIComponent(instance.id)}/manager`;

  return <main className="instance-settings-page" id="workspace" aria-labelledby="instance-settings-title">
    <header className="settings-page-header">
      <button type="button" className="settings-back" onClick={() => leave(onBack)} disabled={busy}><ArrowLeft size={18} aria-hidden="true" />{t('settingsBack')}</button>
      <div className="settings-heading-row">
        <div><p className="settings-eyebrow">{instance.name}</p><h2 id="instance-settings-title" ref={title} tabIndex={-1}>{t('instanceSettings')}</h2><p className="settings-page-description">{t('settingsPageHint')}</p></div>
        <span className={`settings-runtime ${instance.pid ? 'running' : ''}`}><Server size={16} aria-hidden="true" />{instance.pid ? t('running') : t('stopped')}<span>v{instance.version}</span></span>
      </div>
    </header>
    <div className="settings-page-layout">
      <aside className="settings-navigation">
        <nav aria-label={t('instanceSettings')}>
          {tabs.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" aria-current={section === id ? 'page' : undefined} onClick={() => navigate(id)} className={section === id ? 'selected' : ''}>
            <Icon size={20} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span>
            {((id === 'general' && normalized.name !== baseline.name) || (id === 'automation' && (draft.autoStart !== baseline.autoStart || draft.autoRestart !== baseline.autoRestart)) || (id === 'manager' && managerChanged)) && <span className="settings-nav-dirty" aria-label={t('unsavedChanges')} />}
          </button>)}
        </nav>
        <button type="button" className="settings-config-link" onClick={() => leave(onOpenProxyConfig)} disabled={busy}><GitBranch size={19} aria-hidden="true" /><span>{t('settingsProxyConfig')}<small>{t('settingsProxyHint')}</small></span><ArrowUpRight size={16} aria-hidden="true" /></button>
      </aside>
      <div className="settings-content" ref={content}>
        <div className="settings-section-heading"><h3>{active.label}</h3><p>{active.description}</p></div>
        {feedback && <div className={`settings-feedback ${feedback.error ? 'error' : 'success'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.error ? null : <CheckCircle2 size={18} aria-hidden="true" />}{feedback.text}</div>}
        <section hidden={section !== 'general'} aria-label={t('settingsGeneral')}>
          <div className="settings-two-columns">
            <div className="settings-card"><h4>{t('instanceName')}</h4><p>{t('settingsNameHint')}</p>
              <label htmlFor="instance-name">{t('instanceName')}</label><input id="instance-name" value={draft.name} disabled={saving} aria-invalid={nameError} aria-describedby={nameError ? 'instance-name-error' : undefined} onChange={event => { edit('name', event.target.value); if (event.target.value.trim()) setNameError(false); }} />
              {nameError && <p id="instance-name-error" className="form-error" role="alert">{t('settingsNameRequired')}</p>}
            </div>
            <div className="settings-card settings-info-card"><Fingerprint size={22} aria-hidden="true" /><h4>{t('settingsIdentity')}</h4><p>{t('settingsIdentityHint')}</p>
              <dl><div><dt>Instance ID</dt><dd><code>{instance.id}</code><button type="button" className="settings-icon-button" onClick={() => copy(instance.id, 'id')} aria-label={copied === 'id' ? t('settingsCopied') : t('settingsCopyId')}>{copied === 'id' ? <Check size={18} /> : <Copy size={18} />}</button></dd></div><div><dt>{t('platform')}</dt><dd>{instance.platform}</dd></div><div><dt>{t('currentVersion')}</dt><dd>v{instance.version}</dd></div></dl>
            </div>
          </div>
          <div className="settings-callout"><CheckCircle2 size={20} aria-hidden="true" /><div><strong>{t('settingsApplyTitle')}</strong><p>{t('settingsGeneralApplyHint')}</p></div></div>
        </section>
        <section hidden={section !== 'automation'} aria-label={t('settingsAutomation')}>
          <fieldset disabled={saving} className="settings-card settings-automation">
            <div><Switch label={t('autoStart')} checked={draft.autoStart} onChange={value => edit('autoStart', value)} /><p>{t('autoStartDescription')}</p></div>
            <div><Switch label={t('autoRestart')} checked={draft.autoRestart} onChange={value => edit('autoRestart', value)} /><p>{t('autoRestartDescription')}</p></div>
          </fieldset>
          <div className="settings-callout"><Zap size={20} aria-hidden="true" /><div><strong>{t('settingsAutomationApplyTitle')}</strong><p>{t('settingsAutomationApplyHint')}</p></div></div>
        </section>
        <section hidden={section !== 'manager'} aria-label="Manager API">
          <div className="settings-card"><div className="settings-card-title"><h4>{t('settingsManagerConnection')}</h4><span className="settings-status">{instance.managerToken && instance.managerPort ? t('settingsConfigured') : t('settingsNotConfigured')}</span></div><p>{t('settingsManagerConnectionHint')}</p>
            <label htmlFor="manager-url">Manager URL</label><div className="settings-input-actions"><input id="manager-url" value={managerUrl} readOnly /><button type="button" className="btn tertiary" onClick={() => copy(managerUrl, 'url')}><Copy size={16} aria-hidden="true" />{copied === 'url' ? t('settingsCopied') : t('settingsCopy')}</button></div>
            <dl className="settings-manager-facts"><div><dt>Manager port</dt><dd>{instance.managerPort || t('settingsPortAuto')}</dd></div><div><dt>{t('settingsAccess')}</dt><dd>HTTPS / Tailscale</dd></div></dl>
          </div>
          <fieldset disabled={saving} className="settings-card"><h4>{t('settingsAdminToken')}</h4><p>{t('settingsAdminTokenHint')}</p><label htmlFor="manager-token">{t('settingsAdminToken')}</label>
            <div className="settings-input-actions"><input id="manager-token" type={tokenVisible ? 'text' : 'password'} value={draft.managerToken} onChange={event => edit('managerToken', event.target.value)} autoComplete="off" spellCheck={false} />
              <button type="button" className="settings-icon-button" onClick={() => setTokenVisible(!tokenVisible)} aria-label={tokenVisible ? t('settingsHideToken') : t('settingsShowToken')}>{tokenVisible ? <EyeOff size={19} /> : <Eye size={19} />}</button>
              <button type="button" className="settings-icon-button" disabled={!normalized.managerToken} onClick={() => copy(normalized.managerToken, 'token')} aria-label={copied === 'token' ? t('settingsCopied') : t('settingsCopyToken')}>{copied === 'token' ? <Check size={19} /> : <Copy size={19} />}</button>
            </div>
            <button type="button" className="btn tertiary settings-token-generate" onClick={regenerateToken}><KeyRound size={16} aria-hidden="true" />{t('settingsGenerateToken')}</button>
            {managerChanged && <p className="settings-pending" role="status">{t('settingsTokenPending')}</p>}
          </fieldset>
          <div className="settings-callout"><KeyRound size={20} aria-hidden="true" /><div><strong>{t('settingsApplyTitle')}</strong><p>{t('settingsManagerApplyHint')}</p></div></div>
        </section>
        <section hidden={section !== 'certificates'} aria-label={t('settingsCertificates')}>
          {instance.managerPort && instance.managerToken ? certificatesVisited && <div className="settings-card settings-api-card"><ManagerApiPanel instanceId={instance.id} managerToken={instance.managerToken} onBusyChange={setApiBusy} /></div>
          : <div className="settings-card settings-empty"><ShieldCheck size={32} aria-hidden="true" /><h4>{t('settingsManagerRequired')}</h4><p>{t('settingsManagerRequiredHint')}</p><button type="button" className="btn tertiary" onClick={() => navigate('manager')}>{t('settingsOpenManager')}</button></div>}
        </section>
        <section hidden={section !== 'version'} aria-label={t('settingsVersion')}>
          <div className="settings-card"><h4>{t('settingsVersion')}</h4><p>{t('settingsVersionApplyHint')}</p><div className="settings-version-summary"><div><small>{t('currentVersion')}</small><strong>v{instance.version}</strong></div><ArrowUpRight size={22} aria-hidden="true" /><div><small>{t('latestVersion')}</small><strong>v{latestVersion}</strong></div></div>
            <label htmlFor="version-select">{t('updateVersion')}</label><select id="version-select" value={selectedVersion} onChange={event => setSelectedVersion(event.target.value)} disabled={isUpdating}><option value="latest">{t('latestVersion')} (v{latestVersion})</option>{availableVersions.map(item => <option key={item} value={item}>v{item}</option>)}</select>
            <button type="button" className="btn tertiary settings-update-button" disabled={isUpdating || busy} onClick={update}>{isUpdating ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}{isUpdating ? t('updating') : reinstall ? t('reinstallNow') : t('updateNow')}</button>
          </div>
        </section>
      </div>
    </div>
    <footer className="settings-savebar">
      <div className="settings-save-status" aria-live="polite">{dirty ? <span className="unsaved-dot" /> : <CheckCircle2 size={18} aria-hidden="true" />}<div><strong>{dirty ? t('unsavedChanges') : t('savedChanges')}</strong><small>{section === 'certificates' ? t('settingsCertificateSaveHint') : managerChanged ? t('settingsManagerApplyHint') : t('settingsSaveHint')}</small></div></div>
      <div className="settings-save-actions"><button type="button" className="btn tertiary" disabled={!dirty || busy} onClick={() => { if (window.confirm(t('settingsDiscardConfirm'))) { const current = draftOf(instance); setDraft(current); setBaseline(current); setFeedback(null); setNameError(false); setTokenVisible(false); } }}><RotateCcw size={16} aria-hidden="true" />{t('settingsReset')}</button>
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>{saving ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <Save size={18} aria-hidden="true" />}{saving ? t('saving') : t('settingsSaveInstance')}</button></div>
    </footer>
  </main>;
}
