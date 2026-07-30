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
