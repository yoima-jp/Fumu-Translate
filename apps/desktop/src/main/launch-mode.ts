export function isAutostartInvocation(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) => /^--autostart(?:$|=)/iu.test(argument.trim()));
}
