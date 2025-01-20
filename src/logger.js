const path = require("path");
const winston = require("winston");
require("winston-daily-rotate-file");
const { logLevel, logMaxDays, maxInMemoryLogs } = require("./config");

const logDirectory = path.join(__dirname, "..", "logs");

// File rotation
const fileTransport = new winston.transports.DailyRotateFile({
  dirname: logDirectory,
  filename: "qbit-optimizer-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  zippedArchive: false,
  maxSize: "10m",
  maxFiles: `${logMaxDays}d`,
});

// In-memory buffer of recent logs
let memoryLogBuffer = [];

// Custom transport that pushes logs to memoryLogBuffer
class InMemoryTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => this.emit("logged", info));
    const msg = `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`;
    memoryLogBuffer.push(msg);
    if (memoryLogBuffer.length > maxInMemoryLogs) {
      memoryLogBuffer.shift(); // remove oldest
    }
    callback();
  }
}

const memoryTransport = new InMemoryTransport();

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    }),
  ),
  transports: [
    fileTransport,
    new winston.transports.Console(),
    memoryTransport,
  ],
});

function getMemoryLogs() {
  return memoryLogBuffer.reverse();
}

module.exports = {
  logger,
  getMemoryLogs,
};
