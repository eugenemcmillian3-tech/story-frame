import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title || description || actions ? (
        <header className="panel-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p className="panel-description">{description}</p> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

interface FieldShellProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}

/** Label/hint/error surface for a control; the control itself is the child. */
type ControlFieldProps = Omit<FieldShellProps, 'children'>;

export function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  aside,
  children,
}: FieldShellProps) {
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>
          {label}
          {required ? <span className="field-required"> (required)</span> : null}
        </label>
        {aside}
      </div>
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  id,
  label,
  hint,
  error,
  required,
  aside,
  ...input
}: ControlFieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'children'>) {
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      aside={aside}
    >
      <input id={id} className="input" aria-invalid={error ? true : undefined} {...input} />
    </FieldShell>
  );
}

export function TextAreaField({
  id,
  label,
  hint,
  error,
  required,
  aside,
  ...textarea
}: ControlFieldProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'children'>) {
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      aside={aside}
    >
      <textarea
        id={id}
        className="input textarea"
        aria-invalid={error ? true : undefined}
        {...textarea}
      />
    </FieldShell>
  );
}

export function SelectField({
  id,
  label,
  hint,
  error,
  required,
  aside,
  children,
  ...select
}: ControlFieldProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'children'> & {
    children: ReactNode;
  }) {
  return (
    <FieldShell
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      aside={aside}
    >
      <select id={id} className="input select" aria-invalid={error ? true : undefined} {...select}>
        {children}
      </select>
    </FieldShell>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
  hint,
}: {
  legend: string;
  name: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  hint?: string;
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map((option) => (
          <label key={String(option.value)} className="segmented-item">
            <input
              type="radio"
              name={name}
              value={String(option.value)}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}
    </fieldset>
  );
}
