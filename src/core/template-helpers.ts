export function html(
  strings: TemplateStringsArray,
  ...values: any[]
): string {
  return strings.reduce(
    (acc, str, i) => acc + str + (values[i] !== undefined ? values[i] : ''),
    ''
  );
}

export function css(
  strings: TemplateStringsArray,
  ...values: any[]
): string {
  return strings.reduce(
    (acc, str, i) => acc + str + (values[i] !== undefined ? values[i] : ''),
    ''
  );
}
