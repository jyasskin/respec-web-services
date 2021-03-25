import morgan, { FormatFn, Options } from "morgan";
import chalk from "chalk";
import { createStream } from "rotating-file-stream";
import { Request, Response } from "express";
import { env } from "./misc.js";

const LOG_DIR = env("LOG_DIR");

const prettyBytes = (bytes: number) => {
  const threshold = 1024;
  let size = bytes;
  for (const unit of ["B", "KB", "MB"]) {
    if (size >= threshold) {
      size /= threshold;
    } else {
      return `${unit === "B" ? size : size.toFixed(2)} ${unit}`;
    }
  }
  return bytes;
};

const prettyJSON = (() => {
  type BasicTypes = number | boolean | null | string;
  const colored = (value: BasicTypes) => {
    switch (typeof value) {
      case "number":
        return chalk.cyan(value.toString());
      case "boolean":
        return chalk.green(value.toString());
      default:
        return chalk.yellow(value);
    }
  };
  return (obj: Record<string, BasicTypes>) =>
    Object.entries(obj)
      .map(([key, value]) => chalk.magentaBright(key + "=") + colored(value))
      .join(" ");
})();

const tryURL = (url?: string, base?: string) => {
  try {
    if (!url) return null;
    return new URL(url, base);
  } catch {
    return null;
  }
};

type FormatFnParams = Parameters<FormatFn<Request, Response>>;
const getFields = (...[tokens, req, res]: FormatFnParams) => {
  const date = tokens.date(req, res, "iso");
  const remoteAddr = tokens["remote-addr"](req, res);
  const method = tokens.method(req, res);
  const status = parseInt(tokens.status(req, res) || "", 10);
  const url = tryURL(tokens.url(req, res)!, "https://respec.org/")!;
  const referrer = tryURL(tokens.referrer(req, res));
  const contentLength = res.getHeader("content-length") as number | undefined;
  const responseTime = tokens["response-time"](req, res);
  const locals = Object.keys(res.locals).length ? { ...res.locals } : null;

  return {
    date,
    remoteAddr,
    method,
    status,
    url,
    referrer,
    contentLength,
    responseTime,
    locals,
  };
};

const jsonFormatter: FormatFn<Request, Response> = (tokens, req, res) => {
  const {
    status,
    method,
    referrer,
    date,
    remoteAddr,
    contentLength,
    responseTime,
    locals,
  } = getFields(tokens, req, res);

  return JSON.stringify({
    date,
    remoteAddr,
    method,
    url: tokens.url(req, res)!,
    status,
    referrer: referrer?.href || referrer,
    contentLength,
    responseTime,
    locals,
  });
};

const prettyFormatter: FormatFn<Request, Response> = (tokens, req, res) => {
  const {
    url,
    status,
    method,
    referrer,
    date,
    remoteAddr,
    contentLength,
    responseTime,
    locals,
  } = getFields(tokens, req, res);

  // Cleaner searchParams, while making sure they stay in single line.
  const searchParams = url.search
    ? decodeURIComponent(url.search).replace(/(\s+)/g, encodeURIComponent)
    : "";
  const color = status < 300 ? "green" : status >= 400 ? "red" : "yellow";
  const request =
    chalk[color](`${method!.padEnd(4)} ${status}`) +
    ` ${chalk.blueBright(url.pathname)}${chalk.italic.gray(searchParams)}`;

  let formattedReferrer: string | undefined;
  if (referrer) {
    const { origin, pathname, search } = referrer;
    formattedReferrer =
      chalk.magenta(origin + chalk.bold(pathname)) + chalk.italic.gray(search);
  }

  const unknown = chalk.dim.gray("-");

  return [
    chalk.gray(date),
    remoteAddr ? chalk.gray(remoteAddr.padStart(15)) : unknown,
    request,
    formattedReferrer || unknown,
    contentLength ? chalk.cyan(prettyBytes(contentLength)) : unknown,
    chalk.cyan(responseTime + " ms"),
    locals ? prettyJSON(locals) : unknown,
  ].join(" | ");
};

const skipCommon = (req: Request, res: Response) => {
  const { method, query } = req;
  const { statusCode } = res;
  const ref = req.get("referer") || req.get("referrer");
  const referrer = tryURL(ref);

  return (
    // successful pre-flight requests
    (method === "OPTIONS" && statusCode === 204) ||
    // automated tests
    (referrer && referrer.host === "localhost:9876") ||
    // successful healthcheck
    (typeof query.healthcheck !== "undefined" && statusCode < 400)
  );
};

const optionsStdout: Options<Request, Response> = {
  skip: (req, res) => res.statusCode >= 400 || skipCommon(req, res),
  stream: process.stdout,
};

const optionsStderr: Options<Request, Response> = {
  skip: (req, res) => res.statusCode < 400 || skipCommon(req, res),
  stream: process.stderr,
};

const optionsAccess: Options<Request, Response> = {
  stream: createStream("access.log", { interval: "1d", path: LOG_DIR }),
};

export const stdout = () => morgan(prettyFormatter, optionsStdout);
export const stderr = () => morgan(prettyFormatter, optionsStderr);
export const access = () => morgan(jsonFormatter, optionsAccess);
