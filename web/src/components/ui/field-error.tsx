function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-1 font-mono text-[10px] text-destructive">{message}</p>
}

export { FieldError }
