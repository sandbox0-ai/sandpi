import type {
  CreateEnvironmentEgressCredentialInput,
  EnvironmentCredentialMaterial,
  EnvironmentCredentialProjectionType,
  EnvironmentCredentialProtocol,
  EnvironmentEgressCredential,
  EnvironmentEgressCredentialConfiguration,
} from "@/lib/environment-credentials";

const VALUE_TEMPLATE = "{{ .value }}";

export interface EnvironmentCredentialForm {
  name: string;
  projectionType: EnvironmentCredentialProjectionType;
  domains: string;
  ports: string;
  protocol: EnvironmentCredentialProtocol;
  failurePolicy: "fail-closed" | "fail-open";
  headerName: string;
  headerPrefix: string;
  placeholder: string;
  useHeader: boolean;
  useQuery: boolean;
  useBody: boolean;
  certificatePem: string;
  privateKeyPem: string;
  caPem: string;
  username: string;
  password: string;
  passphrase: string;
  upstreamUsername: string;
  sandboxPublicKeys: string;
  knownHosts: string;
  sourceValues: Record<string, string>;
}

export const ENVIRONMENT_CREDENTIAL_TYPES: Array<{
  type: EnvironmentCredentialProjectionType;
  label: string;
}> = [
  { type: "http_headers", label: "HTTP header" },
  { type: "placeholder_substitution", label: "Request placeholder" },
  { type: "tls_client_certificate", label: "mTLS certificate" },
  { type: "username_password", label: "Username & password" },
  { type: "ssh_proxy", label: "SSH private key" },
];

export function emptyEnvironmentCredentialForm(
  projectionType: EnvironmentCredentialProjectionType = "http_headers",
): EnvironmentCredentialForm {
  const protocol = defaultProtocol(projectionType);
  return {
    name: "",
    projectionType,
    domains: "",
    ports: String(defaultPort(protocol)),
    protocol,
    failurePolicy: "fail-closed",
    headerName: "Authorization",
    headerPrefix: "Bearer",
    placeholder: "",
    useHeader: true,
    useQuery: false,
    useBody: false,
    certificatePem: "",
    privateKeyPem: "",
    caPem: "",
    username: "",
    password: "",
    passphrase: "",
    upstreamUsername: "",
    sandboxPublicKeys: "",
    knownHosts: "",
    sourceValues: { value: "" },
  };
}

export function environmentCredentialFormForProjection(
  current: EnvironmentCredentialForm,
  projectionType: EnvironmentCredentialProjectionType,
) {
  const next = emptyEnvironmentCredentialForm(projectionType);
  return {
    ...next,
    name: current.name,
    domains: current.domains,
    failurePolicy: current.failurePolicy,
  };
}

export function environmentCredentialFormFromCredential(
  credential: EnvironmentEgressCredential,
): EnvironmentCredentialForm {
  return {
    ...emptyEnvironmentCredentialForm(credential.projection.type),
    name: credential.name,
    domains: credential.rule.domains.join("\n"),
    ports: credential.rule.ports.map(({ port }) => port).join(", "),
    protocol: credential.rule.protocol,
    failurePolicy: credential.rule.failurePolicy,
  };
}

export function environmentCredentialRotationForm(
  credential: EnvironmentEgressCredential,
): EnvironmentCredentialForm {
  const form = environmentCredentialFormFromCredential(credential);
  return {
    ...form,
    sourceValues: Object.fromEntries(
      environmentCredentialSourceValueKeys(credential).map((key) => [key, ""]),
    ),
  };
}

export function environmentCredentialCreateInput(
  form: EnvironmentCredentialForm,
): CreateEnvironmentEgressCredentialInput {
  const common = commonConfiguration(form);
  switch (form.projectionType) {
    case "http_headers": {
      const headerName = required(form.headerName, "Header name is required.");
      const value = required(
        form.sourceValues.value,
        "Secret value is required.",
        false,
      );
      return {
        ...common,
        resolverKind: "static_headers",
        projection: {
          type: "http_headers",
          headers: [
            {
              name: headerName,
              valueTemplate: [form.headerPrefix.trim(), VALUE_TEMPLATE]
                .filter(Boolean)
                .join(" "),
            },
          ],
        },
        material: { type: "static_headers", values: { value } },
      };
    }
    case "placeholder_substitution": {
      const locations = [
        ...(form.useHeader ? (["header"] as const) : []),
        ...(form.useQuery ? (["query"] as const) : []),
        ...(form.useBody ? (["body"] as const) : []),
      ];
      if (locations.length === 0) {
        throw new Error("Choose at least one replacement location.");
      }
      const value = required(
        form.sourceValues.value,
        "Secret value is required.",
        false,
      );
      return {
        ...common,
        resolverKind: "static_headers",
        projection: {
          type: "placeholder_substitution",
          replacements: [
            {
              placeholder: required(
                form.placeholder,
                "Placeholder is required.",
              ),
              valueTemplate: VALUE_TEMPLATE,
              locations,
            },
          ],
        },
        material: { type: "static_headers", values: { value } },
      };
    }
    case "tls_client_certificate":
      return {
        ...common,
        resolverKind: "static_tls_client_certificate",
        projection: { type: "tls_client_certificate" },
        material: {
          type: "static_tls_client_certificate",
          certificatePem: required(
            form.certificatePem,
            "Client certificate is required.",
          ),
          privateKeyPem: required(
            form.privateKeyPem,
            "Private key is required.",
          ),
          ...(form.caPem.trim() ? { caPem: form.caPem.trim() } : {}),
        },
      };
    case "username_password":
      return {
        ...common,
        resolverKind: "static_username_password",
        projection: { type: "username_password" },
        material: {
          type: "static_username_password",
          username: required(form.username, "Username is required."),
          password: required(form.password, "Password is required.", false),
        },
      };
    case "ssh_proxy":
      return {
        ...common,
        resolverKind: "static_ssh_private_key",
        projection: {
          type: "ssh_proxy",
          upstreamUsername: required(
            form.upstreamUsername,
            "Upstream username is required.",
          ),
          sandboxPublicKeys: requiredLines(
            form.sandboxPublicKeys,
            "At least one Sandbox public key is required.",
          ),
          knownHosts: lines(form.knownHosts),
        },
        material: {
          type: "static_ssh_private_key",
          privateKeyPem: required(
            form.privateKeyPem,
            "Private key is required.",
          ),
          ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        },
      };
  }
}

export function environmentCredentialEditInput(
  credential: EnvironmentEgressCredential,
  form: EnvironmentCredentialForm,
): EnvironmentEgressCredentialConfiguration {
  return {
    ...commonConfiguration(form),
    resolverKind: credential.resolverKind,
    projection: credential.projection,
    enabled: credential.enabled,
  };
}

export function environmentCredentialRotationMaterial(
  credential: EnvironmentEgressCredential,
  form: EnvironmentCredentialForm,
): EnvironmentCredentialMaterial {
  switch (credential.resolverKind) {
    case "static_headers": {
      const values = Object.fromEntries(
        environmentCredentialSourceValueKeys(credential).map((key) => [
          key,
          required(
            form.sourceValues[key] ?? "",
            `Secret value for ${key} is required.`,
            false,
          ),
        ]),
      );
      return { type: "static_headers", values };
    }
    case "static_tls_client_certificate":
      return {
        type: "static_tls_client_certificate",
        certificatePem: required(
          form.certificatePem,
          "Client certificate is required.",
        ),
        privateKeyPem: required(
          form.privateKeyPem,
          "Private key is required.",
        ),
        ...(form.caPem.trim() ? { caPem: form.caPem.trim() } : {}),
      };
    case "static_username_password":
      return {
        type: "static_username_password",
        username: required(form.username, "Username is required."),
        password: required(form.password, "Password is required.", false),
      };
    case "static_ssh_private_key":
      return {
        type: "static_ssh_private_key",
        privateKeyPem: required(
          form.privateKeyPem,
          "Private key is required.",
        ),
        ...(form.passphrase ? { passphrase: form.passphrase } : {}),
      };
  }
}

export function environmentCredentialConfigurationFor(
  credential: EnvironmentEgressCredential,
  changes: Partial<Pick<EnvironmentEgressCredentialConfiguration, "enabled">>,
): EnvironmentEgressCredentialConfiguration {
  return {
    name: credential.name,
    resolverKind: credential.resolverKind,
    projection: credential.projection,
    rule: credential.rule,
    enabled: changes.enabled ?? credential.enabled,
  };
}

export function environmentCredentialSourceValueKeys(
  credential: EnvironmentEgressCredential,
) {
  const templates =
    credential.projection.type === "http_headers"
      ? credential.projection.headers.map(({ valueTemplate }) => valueTemplate)
      : credential.projection.type === "placeholder_substitution"
        ? credential.projection.replacements.map(
            ({ valueTemplate }) => valueTemplate,
          )
        : [];
  const keys = new Set<string>();
  for (const template of templates) {
    for (const match of template.matchAll(/{{\s*\.([A-Za-z0-9_-]+)\s*}}/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }
  return keys.size > 0 ? [...keys] : ["value"];
}

export function environmentCredentialProtocolOptions(
  projectionType: EnvironmentCredentialProjectionType,
): EnvironmentCredentialProtocol[] {
  if (
    projectionType === "http_headers" ||
    projectionType === "placeholder_substitution"
  ) {
    return ["http", "https", "grpc"];
  }
  if (projectionType === "tls_client_certificate") return ["tls"];
  if (projectionType === "username_password") {
    return ["socks5", "mqtt", "redis"];
  }
  return ["ssh"];
}

export function environmentCredentialTypeLabel(
  type: EnvironmentCredentialProjectionType,
) {
  return (
    ENVIRONMENT_CREDENTIAL_TYPES.find(
      (credentialType) => credentialType.type === type,
    )?.label ?? type
  );
}

function commonConfiguration(form: EnvironmentCredentialForm) {
  const domains = lines(form.domains.replaceAll(",", "\n"));
  if (domains.length === 0) {
    throw new Error("At least one destination domain is required.");
  }
  const portValues = form.ports.split(/[\s,]+/).filter(Boolean);
  const ports = portValues.map((value) =>
    /^\d+$/.test(value) ? Number(value) : Number.NaN,
  );
  if (
    ports.length === 0 ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error("TCP ports must be whole numbers from 1 to 65535.");
  }
  return {
    name: required(form.name, "Credential name is required."),
    rule: {
      protocol: form.protocol,
      domains,
      ports: [...new Set(ports)].map((port) => ({
        port,
        protocol: "tcp" as const,
      })),
      failurePolicy: form.failurePolicy,
    },
    enabled: true,
  };
}

function defaultProtocol(
  projectionType: EnvironmentCredentialProjectionType,
): EnvironmentCredentialProtocol {
  if (
    projectionType === "http_headers" ||
    projectionType === "placeholder_substitution"
  ) {
    return "https";
  }
  if (projectionType === "tls_client_certificate") return "tls";
  if (projectionType === "username_password") return "redis";
  return "ssh";
}

function defaultPort(protocol: EnvironmentCredentialProtocol) {
  switch (protocol) {
    case "http":
      return 80;
    case "https":
    case "grpc":
    case "tls":
      return 443;
    case "ssh":
      return 22;
    case "socks5":
      return 1_080;
    case "mqtt":
      return 1_883;
    case "redis":
      return 6_379;
  }
}

function lines(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function requiredLines(value: string, message: string) {
  const values = lines(value);
  if (values.length === 0) throw new Error(message);
  return values;
}

function required(value: string, message: string, trim = true) {
  const normalized = trim ? value.trim() : value;
  if (!normalized) throw new Error(message);
  return normalized;
}
