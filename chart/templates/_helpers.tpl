{{/*
Expand the name of the chart.
*/}}
{{- define "portainer-run.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "portainer-run.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Name of the cache PVC. Shared by the claim, the volume that mounts it, and the
storage-class preflight — which uses it as a `lookup` key, where a drifted name
would silently disable its checks rather than fail loudly.
*/}}
{{- define "portainer-run.cacheClaimName" -}}
{{- printf "%s-cache" (include "portainer-run.fullname" .) -}}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "portainer-run.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "portainer-run.labels" -}}
helm.sh/chart: {{ include "portainer-run.chart" . }}
{{ include "portainer-run.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "portainer-run.selectorLabels" -}}
app.kubernetes.io/name: {{ include "portainer-run.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Storage-class preflight for the cache PVC.

Fails at render time, before anything is applied. Otherwise a bad storageClass
leaves a Pending PVC and a `pending-install` release that the retry adopts but
cannot repair — storageClassName is immutable — so only a namespace wipe
recovers. See R8S-1214.

Skipped when `lookup` returns no classes, meaning either no API connection
(`helm template`, client-side `--dry-run`) or a cluster with genuinely none.
Helm cannot tell those apart, so both are waved through.

A Bound claim is never compared against the cluster default: an empty
storageClass is stamped with the default at creation, so after an admin swaps
that default the live value still names the old one, and comparing would
false-fail every later upgrade of a healthy release. An explicit storageClass
that contradicts a bound claim is still reported.
*/}}
{{- define "portainer-run.validateStorageClass" -}}
{{- $claim := include "portainer-run.cacheClaimName" . -}}
{{- $existing := lookup "v1" "PersistentVolumeClaim" .Release.Namespace $claim -}}
{{- $live := dig "spec" "storageClassName" "" $existing -}}
{{- if eq (dig "status" "phase" "" $existing) "Bound" -}}
{{- if and .Values.storageClass $live (ne .Values.storageClass $live) -}}
{{- fail (printf `

storageClass is set to %q, but PersistentVolumeClaim %q is already bound to
%q, and spec.storageClassName is immutable.

That claim holds the database, so deleting it destroys the stored Git target
credentials. Either set storageClass back to %q, or migrate the data and
delete the claim deliberately.
` .Values.storageClass $claim $live $live) -}}
{{- end -}}
{{- else -}}
{{- $names := list -}}
{{- $default := "" -}}
{{- range (lookup "storage.k8s.io/v1" "StorageClass" "" "").items -}}
{{- $names = append $names .metadata.name -}}
{{- if eq (dig "metadata" "annotations" "storageclass.kubernetes.io/is-default-class" "" .) "true" -}}
{{- $default = .metadata.name -}}
{{- end -}}
{{- end -}}
{{- if $names -}}
{{- $available := join ", " (sortAlpha $names) -}}
{{- if and .Values.storageClass (not (has .Values.storageClass $names)) -}}
{{- fail (printf `

storageClass %q does not exist in this cluster.
Available StorageClasses: %s
Leave storageClass empty to use the cluster default.
` .Values.storageClass $available) -}}
{{- else if and (not .Values.storageClass) (not $default) -}}
{{- fail (printf `

storageClass is empty, but this cluster has no default StorageClass,
so the cache PVC would never bind.
Set storageClass to one of: %s
` $available) -}}
{{- end -}}
{{- end -}}
{{- /* An unbound claim from a failed install gets adopted but cannot be
       corrected. Unbound means no data was written, so deleting it is safe. */ -}}
{{- $want := .Values.storageClass | default $default -}}
{{- if and $want $live (ne $live $want) -}}
{{- fail (printf `

PersistentVolumeClaim %q already exists with storageClass %q, but this
release requests %q. spec.storageClassName is immutable, so the existing
claim cannot be updated in place — it must be deleted first.

Pods from the previous attempt hold the pvc-protection finalizer, so remove
them before the claim:
  kubectl -n %s delete deploy,pod -l app.kubernetes.io/instance=%s
  kubectl -n %s delete pvc %s
` $claim $live $want .Release.Namespace .Release.Name .Release.Namespace $claim) -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Hidden configMap defaults.

These keys are baked into the templates instead of values.yaml so they stay out
of the values list Portainer renders from the OCI chart. They are still written
into the ConfigMap (configmap.yaml) and read by the probe logic (deployment.yaml),
so both stay in sync. Override any of them with `--set configMap.<KEY>=...`.

`hasKey` (rather than sprig `default`) is used so an explicit falsy override is
honored — `default` would treat 0/"" as empty and silently restore the fallback.
*/}}
{{- define "portainer-run.portainerUrl" -}}
{{- $c := .Values.configMap | default dict -}}
{{- if hasKey $c "PORTAINER_URL" }}{{ $c.PORTAINER_URL }}{{ else }}https://portainer.portainer.svc.cluster.local:9443{{ end -}}
{{- end }}

{{- /* Plain-HTTP listen port. Unprivileged so the pod can run as non-root. */}}
{{- define "portainer-run.port" -}}
{{- $c := .Values.configMap | default dict -}}
{{- if hasKey $c "PORT" }}{{ $c.PORT }}{{ else }}8080{{ end -}}
{{- end }}

{{- /* Where Portainer's credential is mounted. One definition for the volume
mount and the server that reads it, so the two cannot drift. */}}
{{- define "portainer-run.credentialDir" -}}
{{- $c := .Values.configMap | default dict -}}
{{- if hasKey $c "MACHINE_CREDENTIAL_DIR" }}{{ $c.MACHINE_CREDENTIAL_DIR }}{{ else }}/var/run/secrets/portainer/addon{{ end -}}
{{- end }}
