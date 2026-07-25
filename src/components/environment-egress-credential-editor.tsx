"use client";

import { AlertTriangle, X } from "lucide-react";

import {
  ENVIRONMENT_CREDENTIAL_TYPES,
  environmentCredentialFormForProjection,
  environmentCredentialProtocolOptions,
  environmentCredentialSourceValueKeys,
  environmentCredentialTypeLabel,
  type EnvironmentCredentialForm,
} from "@/lib/environment-credential-form";
import type {
  EnvironmentCredentialProjectionType,
  EnvironmentCredentialProtocol,
  EnvironmentEgressCredential,
} from "@/lib/environment-credentials";

export type EnvironmentCredentialEditorState =
  | { mode: "create" }
  | { mode: "edit"; credential: EnvironmentEgressCredential }
  | { mode: "rotate"; credential: EnvironmentEgressCredential };

export function EnvironmentEgressCredentialEditor({
  editor,
  form,
  error,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  editor: EnvironmentCredentialEditorState;
  form: EnvironmentCredentialForm;
  error: string;
  saving: boolean;
  onChange: (form: EnvironmentCredentialForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const isCreate = editor.mode === "create";
  const projectionType = isCreate
    ? form.projectionType
    : editor.credential.projection.type;
  const title =
    editor.mode === "create"
      ? "Add credential"
      : editor.mode === "edit"
        ? `Edit ${editor.credential.name}`
        : `Replace secret for ${editor.credential.name}`;

  return (
    <section
      className="environment-credential-editor"
      aria-labelledby="environment-credential-editor-title"
    >
      <header>
        <div>
          <span>{isCreate ? "New Environment credential" : "Write-only"}</span>
          <strong id="environment-credential-editor-title">{title}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close credential editor"
          disabled={saving}
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      {editor.mode !== "rotate" ? (
        <>
          <div className="field-grid two-columns">
            <label>
              Name
              <input
                name="environment-credential-name"
                autoComplete="off"
                value={form.name}
                onChange={(event) =>
                  onChange({ ...form, name: event.target.value })
                }
              />
            </label>
            {isCreate ? (
              <label>
                Credential type
                <select
                  name="environment-credential-type"
                  value={form.projectionType}
                  onChange={(event) =>
                    onChange(
                      environmentCredentialFormForProjection(
                        form,
                        event.target
                          .value as EnvironmentCredentialProjectionType,
                      ),
                    )
                  }
                >
                  {ENVIRONMENT_CREDENTIAL_TYPES.map((credentialType) => (
                    <option
                      value={credentialType.type}
                      key={credentialType.type}
                    >
                      {credentialType.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Credential type
                <input
                  value={environmentCredentialTypeLabel(projectionType)}
                  readOnly
                  aria-readonly="true"
                />
              </label>
            )}
          </div>

          {isCreate ? (
            <CreateMaterialFields
              projectionType={projectionType}
              form={form}
              onChange={onChange}
            />
          ) : (
            <p className="environment-credential-editor-note">
              Edit the destination scope here. Use Replace secret to rotate
              write-only material without changing where it is injected.
            </p>
          )}

          <DestinationFields
            projectionType={projectionType}
            form={form}
            onChange={onChange}
          />
        </>
      ) : (
        <RotationMaterialFields
          credential={editor.credential}
          form={form}
          onChange={onChange}
        />
      )}

      {error ? (
        <div className="codex-extension-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <footer>
        <button
          type="button"
          className="button-secondary"
          disabled={saving}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={saving}
          onClick={onSave}
        >
          {saving
            ? "Saving…"
            : editor.mode === "create"
              ? "Add credential"
              : editor.mode === "edit"
                ? "Save scope"
                : "Replace secret"}
        </button>
      </footer>
    </section>
  );
}

function CreateMaterialFields({
  projectionType,
  form,
  onChange,
}: {
  projectionType: EnvironmentCredentialProjectionType;
  form: EnvironmentCredentialForm;
  onChange: (form: EnvironmentCredentialForm) => void;
}) {
  if (projectionType === "http_headers") {
    return (
      <div className="field-grid two-columns">
        <label>
          Header name
          <input
            name="environment-credential-header-name"
            autoComplete="off"
            value={form.headerName}
            onChange={(event) =>
              onChange({ ...form, headerName: event.target.value })
            }
          />
        </label>
        <label>
          Value prefix
          <input
            name="environment-credential-header-prefix"
            autoComplete="off"
            value={form.headerPrefix}
            placeholder="Bearer"
            onChange={(event) =>
              onChange({ ...form, headerPrefix: event.target.value })
            }
          />
        </label>
        <SecretField
          label="Secret value"
          name="environment-credential-secret"
          value={form.sourceValues.value ?? ""}
          onChange={(value) =>
            onChange({
              ...form,
              sourceValues: { ...form.sourceValues, value },
            })
          }
        />
      </div>
    );
  }
  if (projectionType === "placeholder_substitution") {
    return (
      <>
        <div className="field-grid two-columns">
          <label>
            Placeholder
            <input
              name="environment-credential-placeholder"
              autoComplete="off"
              value={form.placeholder}
              placeholder="SANDPI_API_TOKEN"
              onChange={(event) =>
                onChange({ ...form, placeholder: event.target.value })
              }
            />
          </label>
          <SecretField
            label="Secret value"
            name="environment-credential-secret"
            value={form.sourceValues.value ?? ""}
            onChange={(value) =>
              onChange({
                ...form,
                sourceValues: { ...form.sourceValues, value },
              })
            }
          />
        </div>
        <fieldset className="environment-credential-locations">
          <legend>Replace in</legend>
          {(
            [
              ["useHeader", "Headers"],
              ["useQuery", "Query"],
              ["useBody", "Body"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={form[key]}
                onChange={(event) =>
                  onChange({ ...form, [key]: event.target.checked })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      </>
    );
  }
  if (projectionType === "tls_client_certificate") {
    return (
      <div className="environment-credential-pem-grid">
        <PemField
          label="Client certificate PEM"
          name="environment-credential-certificate"
          value={form.certificatePem}
          onChange={(certificatePem) =>
            onChange({ ...form, certificatePem })
          }
        />
        <PemField
          label="Private key PEM"
          name="environment-credential-private-key"
          value={form.privateKeyPem}
          secret
          onChange={(privateKeyPem) => onChange({ ...form, privateKeyPem })}
        />
        <PemField
          label="CA certificate PEM (optional)"
          name="environment-credential-ca"
          value={form.caPem}
          onChange={(caPem) => onChange({ ...form, caPem })}
        />
      </div>
    );
  }
  if (projectionType === "username_password") {
    return (
      <div className="field-grid two-columns">
        <SecretField
          label="Username"
          name="environment-credential-username"
          value={form.username}
          text
          onChange={(username) => onChange({ ...form, username })}
        />
        <SecretField
          label="Password"
          name="environment-credential-password"
          value={form.password}
          onChange={(password) => onChange({ ...form, password })}
        />
      </div>
    );
  }
  return (
    <div className="environment-credential-pem-grid">
      <label className="full-field">
        Upstream username
        <input
          name="environment-credential-upstream-username"
          autoComplete="off"
          value={form.upstreamUsername}
          onChange={(event) =>
            onChange({ ...form, upstreamUsername: event.target.value })
          }
        />
      </label>
      <PemField
        label="Private key PEM"
        name="environment-credential-private-key"
        value={form.privateKeyPem}
        secret
        onChange={(privateKeyPem) => onChange({ ...form, privateKeyPem })}
      />
      <SecretField
        label="Private key passphrase (optional)"
        name="environment-credential-passphrase"
        value={form.passphrase}
        onChange={(passphrase) => onChange({ ...form, passphrase })}
      />
      <PemField
        label="Sandbox public keys (one per line)"
        name="environment-credential-sandbox-public-keys"
        value={form.sandboxPublicKeys}
        onChange={(sandboxPublicKeys) =>
          onChange({ ...form, sandboxPublicKeys })
        }
      />
      <PemField
        label="Known hosts entries (optional, one per line)"
        name="environment-credential-known-hosts"
        value={form.knownHosts}
        onChange={(knownHosts) => onChange({ ...form, knownHosts })}
      />
    </div>
  );
}

function RotationMaterialFields({
  credential,
  form,
  onChange,
}: {
  credential: EnvironmentEgressCredential;
  form: EnvironmentCredentialForm;
  onChange: (form: EnvironmentCredentialForm) => void;
}) {
  if (credential.resolverKind === "static_headers") {
    const keys = environmentCredentialSourceValueKeys(credential);
    return (
      <div className="field-grid two-columns">
        {keys.map((key) => (
          <SecretField
            key={key}
            label={keys.length === 1 ? "Secret value" : `Secret value: ${key}`}
            name={`environment-credential-source-${key}`}
            value={form.sourceValues[key] ?? ""}
            onChange={(value) =>
              onChange({
                ...form,
                sourceValues: { ...form.sourceValues, [key]: value },
              })
            }
          />
        ))}
      </div>
    );
  }
  if (credential.resolverKind === "static_tls_client_certificate") {
    return (
      <div className="environment-credential-pem-grid">
        <PemField
          label="Client certificate PEM"
          name="environment-credential-certificate"
          value={form.certificatePem}
          onChange={(certificatePem) =>
            onChange({ ...form, certificatePem })
          }
        />
        <PemField
          label="Private key PEM"
          name="environment-credential-private-key"
          value={form.privateKeyPem}
          secret
          onChange={(privateKeyPem) => onChange({ ...form, privateKeyPem })}
        />
        <PemField
          label="CA certificate PEM (optional)"
          name="environment-credential-ca"
          value={form.caPem}
          onChange={(caPem) => onChange({ ...form, caPem })}
        />
      </div>
    );
  }
  if (credential.resolverKind === "static_username_password") {
    return (
      <div className="field-grid two-columns">
        <SecretField
          label="Username"
          name="environment-credential-username"
          value={form.username}
          text
          onChange={(username) => onChange({ ...form, username })}
        />
        <SecretField
          label="Password"
          name="environment-credential-password"
          value={form.password}
          onChange={(password) => onChange({ ...form, password })}
        />
      </div>
    );
  }
  return (
    <div className="environment-credential-pem-grid">
      <PemField
        label="Private key PEM"
        name="environment-credential-private-key"
        value={form.privateKeyPem}
        secret
        onChange={(privateKeyPem) => onChange({ ...form, privateKeyPem })}
      />
      <SecretField
        label="Private key passphrase (optional)"
        name="environment-credential-passphrase"
        value={form.passphrase}
        onChange={(passphrase) => onChange({ ...form, passphrase })}
      />
    </div>
  );
}

function DestinationFields({
  projectionType,
  form,
  onChange,
}: {
  projectionType: EnvironmentCredentialProjectionType;
  form: EnvironmentCredentialForm;
  onChange: (form: EnvironmentCredentialForm) => void;
}) {
  return (
    <>
      <label className="full-field">
        Destination domains
        <textarea
          name="environment-credential-domains"
          value={form.domains}
          placeholder={"api.example.com\n*.internal.example.com"}
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...form, domains: event.target.value })
          }
        />
        <small>One domain per line. Use *.example.com to match subdomains.</small>
      </label>
      <div className="field-grid environment-credential-destination-grid">
        <label>
          Protocol
          <select
            name="environment-credential-protocol"
            value={form.protocol}
            onChange={(event) =>
              onChange({
                ...form,
                protocol: event.target.value as EnvironmentCredentialProtocol,
              })
            }
          >
            {environmentCredentialProtocolOptions(projectionType).map(
              (protocol) => (
                <option value={protocol} key={protocol}>
                  {protocol}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          TCP ports
          <input
            name="environment-credential-ports"
            inputMode="numeric"
            value={form.ports}
            placeholder="443"
            onChange={(event) =>
              onChange({ ...form, ports: event.target.value })
            }
          />
        </label>
        <label>
          Injection failure
          <select
            name="environment-credential-failure-policy"
            value={form.failurePolicy}
            onChange={(event) =>
              onChange({
                ...form,
                failurePolicy: event.target.value as
                  | "fail-closed"
                  | "fail-open",
              })
            }
          >
            <option value="fail-closed">Block request</option>
            <option value="fail-open">Send without credential</option>
          </select>
        </label>
      </div>
    </>
  );
}

function SecretField({
  label,
  name,
  value,
  text = false,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  text?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input
        type={text ? "text" : "password"}
        name={name}
        autoComplete={text ? "off" : "new-password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function PemField({
  label,
  name,
  value,
  secret = false,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="full-field">
      {label}
      <textarea
        name={name}
        autoComplete={secret ? "new-password" : "off"}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
