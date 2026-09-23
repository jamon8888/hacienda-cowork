import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocaleKey } from '../../i18n';
import type { TOptions } from 'i18next';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import {
  CUA_ACCESS_PERMISSION_KINDS,
  DEFAULT_CUA_ACCESS_POLICY,
  getCuaAccessAppPolicy,
  normalizeCuaAppId,
  type CuaAccessAppPolicy,
  type CuaAccessPermissionKind,
  type CuaAccessPolicy,
  type CuaAccessPolicyMode,
  type CuaAccessRule,
} from '../../../shared/cuaAccessPolicy';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '../ui/select';
import { SettingsRow } from './SettingsSection';
import { useAgentActivityMap } from '@/hooks/useAgentActivityMap';
import { getRuntimeSystemInfo, nativeTools } from '@/ipc';
import {
  CODEX_SANDBOX_MODE_CHANGED_EVENT,
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexReadAccessMode,
  type CodexSandboxMode,
} from '@/lib/codex/sandbox-ui';
import { trackSettingChanged } from '@/utils/telemetry';

type ApprovalPolicy = 'never' | 'on-failure' | 'on-request' | 'untrusted';
type FileReadAccess = 'folder' | 'anywhere';
type FileWriteAccess = 'ask-first' | 'folder' | 'anywhere';
type TempAccess = 'off' | 'on';

type RuntimePermissionChange =
  | { kind: 'view-files'; value: FileReadAccess }
  | { kind: 'change-files'; value: FileWriteAccess }
  | { kind: 'temporary-files'; value: TempAccess }
  | { kind: 'network'; value: boolean };

type RuntimeSelectOption = {
  value: string;
  labelKey: LocaleKey;
  descriptionKey: LocaleKey;
};

const FILE_READ_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'folder',
    labelKey: 'nativetools.optCurrentFolder',
    descriptionKey: 'nativetools.optCurrentFolderReadDesc',
  },
  {
    value: 'anywhere',
    labelKey: 'nativetools.optAnywhere',
    descriptionKey: 'nativetools.optAnywhereReadDesc',
  },
];

const FILE_WRITE_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'ask-first',
    labelKey: 'nativetools.optAskFirst',
    descriptionKey: 'nativetools.optAskFirstWriteDesc',
  },
  {
    value: 'folder',
    labelKey: 'nativetools.optCurrentFolder',
    descriptionKey: 'nativetools.optCurrentFolderWriteDesc',
  },
  {
    value: 'anywhere',
    labelKey: 'nativetools.optAnywhere',
    descriptionKey: 'nativetools.optAnywhereWriteDesc',
  },
];

const TEMP_ACCESS_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'off',
    labelKey: 'nativetools.optOff',
    descriptionKey: 'nativetools.optOffDesc',
  },
  {
    value: 'on',
    labelKey: 'nativetools.optOn',
    descriptionKey: 'nativetools.optOnDesc',
  },
];

const CUA_ACCESS_MODE_OPTIONS: RuntimeSelectOption[] = [
  {
    value: 'ask',
    labelKey: 'nativetools.optAsk',
    descriptionKey: 'nativetools.optAskDesc',
  },
  {
    value: 'deny',
    labelKey: 'nativetools.optNever',
    descriptionKey: 'nativetools.optNeverDesc',
  },
  {
    value: 'all',
    labelKey: 'nativetools.optAllow',
    descriptionKey: 'nativetools.optAllowDesc',
  },
];

const CUA_PERMISSION_LABEL_KEYS: Record<CuaAccessPermissionKind, LocaleKey> = {
  inspect: 'nativetools.permInspect',
  control: 'nativetools.permControl',
};

function findOption(
  options: RuntimeSelectOption[],
  value: string,
): RuntimeSelectOption {
  return options.find((option) => option.value === value) ?? options[0];
}

function deriveFileReadAccess(
  sandboxMode: CodexSandboxMode,
  readAccessMode: CodexReadAccessMode,
): FileReadAccess {
  if (sandboxMode === 'danger-full-access' || readAccessMode === 'full-system') {
    return 'anywhere';
  }
  return 'folder';
}

function deriveFileWriteAccess(
  sandboxMode: CodexSandboxMode,
  approvalPolicy: ApprovalPolicy,
): FileWriteAccess {
  if (sandboxMode === 'danger-full-access') {
    return 'anywhere';
  }
  if (approvalPolicy === 'on-request' || approvalPolicy === 'untrusted' || sandboxMode === 'read-only') {
    return 'ask-first';
  }
  return 'folder';
}

function deriveTempAccess(
  tempAccessEnabled: boolean,
  _screenshotAccessEnabled: boolean,
): TempAccess {
  return tempAccessEnabled ? 'on' : 'off';
}

function getRuntimeChangeLabelKey(change: RuntimePermissionChange): LocaleKey {
  switch (change.kind) {
    case 'view-files':
      return 'nativetools.changeLabelView';
    case 'change-files':
      return 'nativetools.changeLabelChange';
    case 'temporary-files':
      return 'nativetools.changeLabelTemp';
    case 'network':
      return 'nativetools.changeLabelNetwork';
  }
}

function replaceCuaPolicyRule(
  policy: CuaAccessPolicy,
  permissionKind: CuaAccessPermissionKind,
  nextRule: CuaAccessRule,
): CuaAccessPolicy {
  return {
    ...policy,
    permissions: {
      ...policy.permissions,
      [permissionKind]: nextRule,
    },
  };
}

function replaceCuaAppPolicy(
  policy: CuaAccessPolicy,
  nextAppPolicy: CuaAccessAppPolicy | null,
): CuaAccessPolicy {
  if (!nextAppPolicy) {
    return policy;
  }

  const appPolicies = policy.appPolicies.filter((appPolicy) => appPolicy.appId !== nextAppPolicy.appId);
  appPolicies.push(nextAppPolicy);
  return {
    ...policy,
    appPolicies,
  };
}

function removeCuaAppPolicy(
  policy: CuaAccessPolicy,
  appId: string,
): CuaAccessPolicy {
  return {
    ...policy,
    appPolicies: policy.appPolicies.filter((appPolicy) => appPolicy.appId !== appId),
  };
}

function replaceCuaAppPolicyRule(
  appPolicy: CuaAccessAppPolicy,
  permissionKind: CuaAccessPermissionKind,
  nextRule: CuaAccessRule,
): CuaAccessAppPolicy {
  return {
    ...appPolicy,
    permissions: {
      ...appPolicy.permissions,
      [permissionKind]: nextRule,
    },
  };
}

function buildDefaultCuaAppPolicy(appId: string, basePolicy: CuaAccessPolicy): CuaAccessAppPolicy {
  return {
    appId,
    displayName: appId,
    permissions: basePolicy.permissions,
  };
}

function requiresDangerousAccessConfirmation(change: RuntimePermissionChange): boolean {
  return change.kind === 'change-files' && change.value === 'anywhere';
}

function RuntimeSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: RuntimeSelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selected = findOption(options, value);
  const { t } = useTranslation();

  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger
        className="w-full justify-between sm:w-[15.5rem]"
        aria-label={t(selected.labelKey)}
      >
        <span className="truncate">{t(selected.labelKey)}</span>
      </SelectTrigger>
      <SelectContent align="end" position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex flex-col items-start gap-0.5">
              <span>{t(option.labelKey)}</span>
              <span className="text-ui-xs leading-5 text-muted-foreground">
                {t(option.descriptionKey)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function NativeToolsSection() {
  "use no memo";

  const isMac = getRuntimeSystemInfo().platform === 'darwin';
  const { t } = useTranslation();
  const translate = useCallback((key: LocaleKey, options?: TOptions) => t(key, options), [t]);
  const agentActivityMap = useAgentActivityMap();
  const [codexNetworkAccess, setCodexNetworkAccess] = useState(true);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('on-request');
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>('workspace-write');
  const [readAccessMode, setReadAccessMode] = useState<CodexReadAccessMode>('workspace-only');
  const [macosTempAccess, setMacosTempAccess] = useState(true);
  const [macosScreenshotAccess, setMacosScreenshotAccess] = useState(true);
  const [cuaAccessPolicy, setCuaAccessPolicy] = useState<CuaAccessPolicy>(DEFAULT_CUA_ACCESS_POLICY);
  const [newCuaAppName, setNewCuaAppName] = useState('');
  const [loading, setLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [isSavingCuaPolicy, setIsSavingCuaPolicy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cuaPolicyError, setCuaPolicyError] = useState<string | null>(null);
  const [dangerousChange, setDangerousChange] = useState<RuntimePermissionChange | null>(null);
  const [pendingChange, setPendingChange] = useState<RuntimePermissionChange | null>(null);

  const runningConversationCount = useMemo(
    () => Array.from(agentActivityMap.values()).filter((activity) => activity.isRunning).length,
    [agentActivityMap],
  );

  useEffect(() => {
    async function load() {
      try {
        const [
          codexNetResult,
          approvalResult,
          sandboxResult,
          readAccessResult,
          macosTempResult,
          macosScreenshotResult,
          cuaPolicyResult,
        ] = await Promise.all([
          nativeTools.getNetworkAccess(),
          nativeTools.getApprovalPolicy(),
          nativeTools.getSandboxMode(),
          nativeTools.getReadAccessMode(),
          isMac ? nativeTools.getMacosTempAccess() : Promise.resolve({ enabled: true }),
          isMac ? nativeTools.getMacosScreenshotAccess() : Promise.resolve({ enabled: true }),
          nativeTools.getCuaAccessPolicy(),
        ]);

        setCodexNetworkAccess(codexNetResult.enabled ?? true);
        setApprovalPolicy((approvalResult.policy ?? 'on-request') as ApprovalPolicy);
        setSandboxMode((sandboxResult.mode ?? DEFAULT_CODEX_SANDBOX_MODE) as CodexSandboxMode);
        setReadAccessMode((readAccessResult.mode ?? 'workspace-only') as CodexReadAccessMode);
        setMacosTempAccess(macosTempResult.enabled ?? true);
        setMacosScreenshotAccess(macosScreenshotResult.enabled ?? true);
        setCuaAccessPolicy(cuaPolicyResult.policy);
      } catch (error) {
        console.error('Failed to load runtime permissions:', error);
        setErrorMessage(translate('nativetools.statusLoadFailed'));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [isMac]);

  const applyLocalRuntimeChange = useCallback((change: RuntimePermissionChange) => {
    switch (change.kind) {
      case 'view-files':
        setReadAccessMode(change.value === 'anywhere' ? 'full-system' : 'workspace-only');
        break;
      case 'change-files':
        if (change.value === 'ask-first') {
          setApprovalPolicy('untrusted');
          setSandboxMode('workspace-write');
        } else if (change.value === 'folder') {
          setApprovalPolicy('never');
          setSandboxMode('workspace-write');
        } else {
          setApprovalPolicy('never');
          setSandboxMode('danger-full-access');
          setReadAccessMode('full-system');
        }
        window.dispatchEvent(new CustomEvent(CODEX_SANDBOX_MODE_CHANGED_EVENT, {
          detail: {
            mode:
              change.value === 'ask-first'
                ? 'workspace-write'
                : change.value === 'folder'
                  ? 'workspace-write'
                  : 'danger-full-access',
          },
        }));
        break;
      case 'temporary-files': {
        const enabled = change.value === 'on';
        setMacosTempAccess(enabled);
        setMacosScreenshotAccess(enabled);
        break;
      }
      case 'network':
        setCodexNetworkAccess(change.value);
        break;
    }
  }, []);

  const persistRuntimeChange = useCallback(async (change: RuntimePermissionChange) => {
    trackSettingChanged({
      settingKey: `runtimePermissions.${change.kind}`,
      tabId: 'permissions',
      sectionId: 'runtimePermissions',
      valueType: 'enum',
      newValue: change.value,
    });
    switch (change.kind) {
      case 'view-files':
        await nativeTools.setReadAccessMode(change.value === 'anywhere' ? 'full-system' : 'workspace-only');
        break;
      case 'change-files':
        if (change.value === 'ask-first') {
          await nativeTools.setApprovalPolicy('untrusted');
          await nativeTools.setSandboxMode('workspace-write');
        } else if (change.value === 'folder') {
          await nativeTools.setApprovalPolicy('never');
          await nativeTools.setSandboxMode('workspace-write');
        } else {
          await nativeTools.setApprovalPolicy('never');
          await nativeTools.setReadAccessMode('full-system');
          await nativeTools.setSandboxMode('danger-full-access');
        }
        break;
      case 'temporary-files': {
        const enabled = change.value === 'on';
        await nativeTools.setMacosTempAccess(enabled);
        await nativeTools.setMacosScreenshotAccess(enabled);
        break;
      }
      case 'network':
        await nativeTools.setNetworkAccess(change.value);
        break;
    }
  }, []);

  const applyRuntimeChange = useCallback(async (change: RuntimePermissionChange) => {
    const changeLabel = translate(getRuntimeChangeLabelKey(change));
    setIsApplying(true);
    setErrorMessage(null);
    setStatusMessage(translate('nativetools.statusRestarting', { change: changeLabel }));

    let didPersist = false;
    try {
      await persistRuntimeChange(change);
      didPersist = true;
      applyLocalRuntimeChange(change);
      await nativeTools.restart();
      setStatusMessage(null);
    } catch (error) {
      console.error(`Failed to update ${changeLabel}:`, error);
      setStatusMessage(null);
      setErrorMessage(
        didPersist
          ? translate('nativetools.statusSavedNoRestart', { change: changeLabel })
          : translate('nativetools.statusUpdateFailed', { change: changeLabel }),
      );
    } finally {
      setIsApplying(false);
    }
  }, [applyLocalRuntimeChange, persistRuntimeChange, translate]);

  const saveCuaPolicy = useCallback(async (nextPolicy: CuaAccessPolicy) => {
    setIsSavingCuaPolicy(true);
    setCuaPolicyError(null);

    try {
      const result = await nativeTools.setCuaAccessPolicy(nextPolicy);
      setCuaAccessPolicy(result.policy);
      return result.policy;
    } catch (error) {
      console.error('Failed to update Computer Use app permissions:', error);
      setCuaPolicyError('Could not update Computer Use app permissions.');
      throw error;
    } finally {
      setIsSavingCuaPolicy(false);
    }
  }, []);

  const addCuaAppRule = useCallback(() => {
    let appId: string;
    try {
      appId = normalizeCuaAppId(newCuaAppName);
    } catch (error) {
      setCuaPolicyError(error instanceof Error ? error.message : 'Computer Use app rules require an app name.');
      return;
    }

    if (getCuaAccessAppPolicy(cuaAccessPolicy, appId)) {
      setCuaPolicyError(`A Computer Use rule for "${appId}" already exists.`);
      return;
    }

    void saveCuaPolicy(replaceCuaAppPolicy(
      cuaAccessPolicy,
      buildDefaultCuaAppPolicy(appId, cuaAccessPolicy),
    )).then(() => {
      setNewCuaAppName('');
    }).catch(() => {});
  }, [cuaAccessPolicy, newCuaAppName, saveCuaPolicy]);

  const queueOrApplyRuntimeChange = useCallback((change: RuntimePermissionChange) => {
    if (isApplying) return;
    setErrorMessage(null);

    if (runningConversationCount > 0) {
      setPendingChange(change);
      return;
    }

    void applyRuntimeChange(change);
  }, [applyRuntimeChange, isApplying, runningConversationCount]);

  const requestRuntimeChange = useCallback((change: RuntimePermissionChange) => {
    if (isApplying) return;
    setErrorMessage(null);

    if (requiresDangerousAccessConfirmation(change)) {
      setDangerousChange(change);
      return;
    }

    queueOrApplyRuntimeChange(change);
  }, [isApplying, queueOrApplyRuntimeChange]);

  const confirmDangerousChange = useCallback(() => {
    if (!dangerousChange) {
      return;
    }

    const change = dangerousChange;
    setDangerousChange(null);
    queueOrApplyRuntimeChange(change);
  }, [dangerousChange, queueOrApplyRuntimeChange]);

  const confirmPendingChange = useCallback(() => {
    if (!pendingChange) return;
    const change = pendingChange;
    setPendingChange(null);
    void applyRuntimeChange(change);
  }, [applyRuntimeChange, pendingChange]);

  const fileWriteAccess = useMemo(
    () => deriveFileWriteAccess(sandboxMode, approvalPolicy),
    [approvalPolicy, sandboxMode],
  );
  const fileReadAccess = useMemo(
    () => (
      fileWriteAccess === 'anywhere'
        ? 'anywhere'
        : deriveFileReadAccess(sandboxMode, readAccessMode)
    ),
    [fileWriteAccess, readAccessMode, sandboxMode],
  );
  const tempAccess = useMemo(
    () => deriveTempAccess(macosTempAccess, macosScreenshotAccess),
    [macosScreenshotAccess, macosTempAccess],
  );

  if (loading) {
    return <div className="py-[18px] text-ui-sm text-muted-foreground">{translate('common.loading')}</div>;
  }

  return (
    <>
      <SettingsRow
        label={translate('nativetools.viewFiles')}
        description={
          fileWriteAccess === 'anywhere'
            ? translate('nativetools.viewFilesIncluded')
            : translate('nativetools.viewFilesDesc')
        }
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={fileReadAccess}
          options={FILE_READ_OPTIONS}
          disabled={isApplying || fileWriteAccess === 'anywhere'}
          onChange={(value) => {
            const nextValue = value as FileReadAccess;
            if (nextValue === fileReadAccess || fileWriteAccess === 'anywhere') {
              return;
            }
            requestRuntimeChange({ kind: 'view-files', value: nextValue });
          }}
        />
      </SettingsRow>

      <SettingsRow
        label={translate('nativetools.changeFiles')}
        description={translate('nativetools.changeFilesDesc')}
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={fileWriteAccess}
          options={FILE_WRITE_OPTIONS}
          disabled={isApplying}
          onChange={(value) => {
            const nextValue = value as FileWriteAccess;
            if (nextValue === fileWriteAccess) {
              return;
            }
            requestRuntimeChange({ kind: 'change-files', value: nextValue });
          }}
        />
      </SettingsRow>

      {isMac ? (
        <SettingsRow
          label={translate('nativetools.tempFiles')}
          description={
            tempAccess === 'off'
              ? translate('nativetools.tempFilesDescOff')
              : translate('nativetools.tempFilesDescOn')
          }
          contentClassName="sm:justify-end"
        >
          <RuntimeSelect
            value={tempAccess}
            options={TEMP_ACCESS_OPTIONS}
            disabled={isApplying}
            onChange={(value) => {
              const nextValue = value as TempAccess;
              if (nextValue === tempAccess) {
                return;
              }
              requestRuntimeChange({ kind: 'temporary-files', value: nextValue });
            }}
          />
        </SettingsRow>
      ) : null}

      <SettingsRow
        label={translate('nativetools.inspectApps')}
        description={translate('nativetools.inspectAppsDesc')}
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={cuaAccessPolicy.permissions.inspect.mode}
          options={CUA_ACCESS_MODE_OPTIONS}
          disabled={isSavingCuaPolicy}
          onChange={(value) => {
            const nextValue = value as CuaAccessPolicyMode;
            if (nextValue === cuaAccessPolicy.permissions.inspect.mode) {
              return;
            }
            void saveCuaPolicy(replaceCuaPolicyRule(cuaAccessPolicy, 'inspect', { mode: nextValue })).catch(() => {});
          }}
        />
      </SettingsRow>

      <SettingsRow
        label={translate('nativetools.controlApps')}
        description={translate('nativetools.controlAppsDesc')}
        contentClassName="sm:justify-end"
      >
        <RuntimeSelect
          value={cuaAccessPolicy.permissions.control.mode}
          options={CUA_ACCESS_MODE_OPTIONS}
          disabled={isSavingCuaPolicy}
          onChange={(value) => {
            const nextValue = value as CuaAccessPolicyMode;
            if (nextValue === cuaAccessPolicy.permissions.control.mode) {
              return;
            }
            void saveCuaPolicy(replaceCuaPolicyRule(cuaAccessPolicy, 'control', { mode: nextValue })).catch(() => {});
          }}
        />
      </SettingsRow>

      <SettingsRow
        label={translate('nativetools.appRules')}
        description={translate('nativetools.appRulesDesc')}
        layout="wide"
        align="start"
        contentClassName="lg:justify-end"
      >
        <div className="flex w-full max-w-[36rem] flex-col gap-3">
          {cuaAccessPolicy.appPolicies.length > 0 ? (
            <div
              className="overflow-hidden rounded-[var(--oa-radius-md)] bg-[var(--oa-bg-subtle)]"
              style={{ border: 'var(--border-width) solid var(--border)' }}
            >
              {cuaAccessPolicy.appPolicies.map((appPolicy) => (
                <div
                  key={appPolicy.appId}
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between [&+&]:[border-top:var(--border-width)_solid_var(--border)]"
                >
                  <div className="min-w-0 text-ui-sm font-medium text-foreground">
                    {appPolicy.displayName}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {CUA_ACCESS_PERMISSION_KINDS.map((permissionKind) => (
                      <label
                        key={`${appPolicy.appId}-${permissionKind}`}
                        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
                      >
                        <span>{translate(CUA_PERMISSION_LABEL_KEYS[permissionKind])}</span>
                        <RuntimeSelect
                          value={appPolicy.permissions[permissionKind].mode}
                          options={CUA_ACCESS_MODE_OPTIONS}
                          disabled={isSavingCuaPolicy}
                          onChange={(value) => {
                            const nextValue = value as CuaAccessPolicyMode;
                            if (nextValue === appPolicy.permissions[permissionKind].mode) {
                              return;
                            }
                            void saveCuaPolicy(replaceCuaAppPolicy(
                              cuaAccessPolicy,
                              replaceCuaAppPolicyRule(appPolicy, permissionKind, { mode: nextValue }),
                            )).catch(() => {});
                          }}
                        />
                      </label>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={translate('nativetools.removeAppRule', { name: appPolicy.displayName })}
                      disabled={isSavingCuaPolicy}
                      onClick={() => {
                        void saveCuaPolicy(removeCuaAppPolicy(cuaAccessPolicy, appPolicy.appId)).catch(() => {});
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-ui-sm leading-6 text-muted-foreground">
              {translate('nativetools.noAppRules')}
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newCuaAppName}
              disabled={isSavingCuaPolicy}
              placeholder={translate('nativetools.appNamePlaceholder')}
              aria-label={translate('nativetools.appNameAria')}
              onChange={(event) => {
                setNewCuaAppName(event.target.value);
                setCuaPolicyError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addCuaAppRule();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={isSavingCuaPolicy}
              onClick={addCuaAppRule}
            >
              <Plus className="size-4" />
              <span>{translate('nativetools.addApp')}</span>
            </Button>
          </div>
          {cuaPolicyError ? (
            <div className="text-ui-sm text-destructive">{cuaPolicyError}</div>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        label={translate('nativetools.network')}
        description={translate('nativetools.networkDesc')}
      >
        <Switch
          checked={codexNetworkAccess}
          disabled={isApplying}
          onCheckedChange={(checked) => {
            const nextValue = checked === true;
            if (nextValue === codexNetworkAccess) {
              return;
            }
            requestRuntimeChange({ kind: 'network', value: nextValue });
          }}
        />
      </SettingsRow>

      {statusMessage ? (
        <div className="py-[18px] text-ui-sm text-muted-foreground">
          {statusMessage}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="py-[18px] text-ui-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="py-[18px] text-ui-sm leading-6 text-muted-foreground">
        These permissions are shared across every conversation. Changing them restarts Interpreter.
      </div>

      <AlertDialog
        open={dangerousChange !== null}
        onOpenChange={(open) => {
          if (!open && !isApplying) {
            setDangerousChange(null);
          }
        }}
      >
        <AlertDialogContent
          size="default"
          className="gap-0 overflow-hidden p-0"
        >
          <AlertDialogHeader
            className="gap-4 px-6 pb-5 pt-6 sm:px-7 sm:pb-6 sm:pt-7"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--oa-danger-soft) 70%, transparent) 0%, transparent 72%)",
            }}
          >
            <AlertDialogMedia className="bg-[var(--oa-danger-soft)] text-[var(--oa-danger)]">
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>{translate('nativetools.fullAccessTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {translate('nativetools.fullAccessDesc1')}
              {' '}{translate('nativetools.fullAccessDesc2')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
            <AlertDialogCancel
              disabled={isApplying}
              className="sm:min-w-[9rem]"
            >
              {translate('nativetools.keepWorkspace')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isApplying}
              onClick={confirmDangerousChange}
              className="sm:min-w-[10rem]"
            >
              {translate('nativetools.fullAccess')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open && !isApplying) {
            setPendingChange(null);
          }
        }}
      >
        <AlertDialogContent
          size="default"
          className="gap-0 overflow-hidden p-0"
        >
          <AlertDialogHeader
            className="gap-4 px-6 pb-5 pt-6 sm:px-7 sm:pb-6 sm:pt-7"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--oa-bg-subtle) 22%, transparent) 0%, transparent 72%)",
            }}
          >
            <AlertDialogMedia className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle>{translate('approvals.restart.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange
                ? translate('nativetools.restartDesc', { count: runningConversationCount, change: translate(getRuntimeChangeLabelKey(pendingChange)) })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="px-6 pb-5 sm:px-7 sm:pb-6">
            <AlertDialogCancel
              disabled={isApplying}
              className="sm:min-w-[9rem]"
            >
              {translate('nativetools.keepSettings')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isApplying}
              onClick={confirmPendingChange}
              className="sm:min-w-[10rem]"
            >
              {translate('nativetools.restartApply')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
