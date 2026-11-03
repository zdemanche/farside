export function fieldProps(id: string, error: string | undefined) {
  return error
    ? { "aria-invalid": true, "aria-describedby": `${id}-error` }
    : {};
}

export function FieldError({
  id,
  error,
}: {
  id: string;
  error: string | undefined;
}) {
  return error ? (
    <p className="field-error" id={`${id}-error`} role="alert">
      {error}
    </p>
  ) : null;
}
