export function clientIp(req: Record<string, any>): string | undefined {
  const flyClientIp = req.headers?.['fly-client-ip'];
  return typeof flyClientIp === 'string' && flyClientIp ? flyClientIp : req.ip;
}
