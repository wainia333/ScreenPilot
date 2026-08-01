import type { ModelSelection, ProviderSettings } from './types'

export function ModelField({
  value,
  providers,
  label,
  onChange,
}: {
  value: ModelSelection | null
  providers: ProviderSettings[]
  label: string
  onChange: (value: ModelSelection | null) => void
}) {
  const encoded = value === null ? '' : JSON.stringify(value)
  return (
    <select
      className="select-field"
      value={encoded}
      aria-label={label}
      onChange={(event) => {
        const selection = event.target.value
        onChange(selection.length === 0 ? null : (JSON.parse(selection) as ModelSelection))
      }}
    >
      <option value="">未选择</option>
      {providers.flatMap((provider) =>
        provider.enabledModels.map((model) => {
          const selection = { providerId: provider.id, model }
          return (
            <option value={JSON.stringify(selection)} key={`${provider.id}\u0000${model}`}>
              {provider.name} · {model}
            </option>
          )
        }),
      )}
    </select>
  )
}
