/**
 * Utilidad sencilla para logs de auditoría.
 * En producción, esto debería integrarse con servicios como Winston, Pino
 * o enviarse a un servicio externo de logs (Datadog, Loggly, etc.)
 */

const auditLog = (action, metadata = {}) => {
  const timestamp = new Date().toISOString();
  const userId = metadata.userId || 'system';
  const severity = metadata.severity || 'INFO';
  
  const logEntry = {
    timestamp,
    severity,
    action,
    userId,
    ...metadata
  };

  // Por ahora, solo consola con color
  const color = severity === 'ERROR' ? '\x1b[31m' : (severity === 'WARNING' ? '\x1b[33m' : '\x1b[32m');
  const reset = '\x1b[0m';

  console.log(`${color}[AUDIT] [${timestamp}] [${severity}] ${action}${reset}`, JSON.stringify(metadata));
};

module.exports = { auditLog };
