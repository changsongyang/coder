import "xterm/css/xterm.css";
import type { Interpolation, Theme } from "@emotion/react";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useQuery } from "react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import * as XTerm from "xterm";
import { CanvasAddon } from "xterm-addon-canvas";
import { FitAddon } from "xterm-addon-fit";
import { Unicode11Addon } from "xterm-addon-unicode11";
import { WebLinksAddon } from "xterm-addon-web-links";
import { WebglAddon } from "xterm-addon-webgl";
import { deploymentConfig } from "api/queries/deployment";
import { workspaceByOwnerAndName } from "api/queries/workspaces";
import type { WorkspaceAgent } from "api/typesGenerated";
import { useProxy } from "contexts/ProxyContext";
import { ThemeOverride } from "contexts/ThemeProvider";
import themes from "theme";
import { MONOSPACE_FONT_FAMILY } from "theme/constants";
import { pageTitle } from "utils/page";
import { openMaybePortForwardedURL } from "utils/portForward";
import { terminalWebsocketUrl } from "utils/terminal";
import { getMatchingAgentOrFirst } from "utils/workspace";
import {
  DisconnectedAlert,
  ErrorScriptAlert,
  LoadedScriptsAlert,
  LoadingScriptsAlert,
} from "./TerminalAlerts";

export const Language = {
  workspaceErrorMessagePrefix: "Unable to fetch workspace: ",
  workspaceAgentErrorMessagePrefix: "Unable to fetch workspace agent: ",
  websocketErrorMessagePrefix: "WebSocket failed: ",
};

type TerminalState = "connected" | "disconnected" | "initializing";

const TerminalPage: FC = () => {
  // Maybe one day we'll support a light themed terminal, but terminal coloring
  // is notably a pain because of assumptions certain programs might make about your
  // background color.
  const theme = themes.dark;
  const navigate = useNavigate();
  const { proxy, proxyLatencies } = useProxy();
  const params = useParams() as { username: string; workspace: string };
  const username = params.username.replace("@", "");
  const xtermRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<XTerm.Terminal | null>(null);
  const [terminalState, setTerminalState] =
    useState<TerminalState>("initializing");
  const [searchParams] = useSearchParams();
  const isDebugging = searchParams.has("debug");
  // The reconnection token is a unique token that identifies
  // a terminal session. It's generated by the client to reduce
  // a round-trip, and must be a UUIDv4.
  const reconnectionToken = searchParams.get("reconnect") ?? uuidv4();
  const command = searchParams.get("command") || undefined;
  // The workspace name is in the format:
  // <workspace name>[.<agent name>]
  const workspaceNameParts = params.workspace?.split(".");
  const workspace = useQuery(
    workspaceByOwnerAndName(username, workspaceNameParts?.[0]),
  );
  const workspaceAgent = workspace.data
    ? getMatchingAgentOrFirst(workspace.data, workspaceNameParts?.[1])
    : undefined;
  const selectedProxy = proxy.proxy;
  const latency = selectedProxy ? proxyLatencies[selectedProxy.id] : undefined;

  const config = useQuery(deploymentConfig());
  const renderer = config.data?.config.web_terminal_renderer;

  // handleWebLink handles opening of URLs in the terminal!
  const handleWebLink = useCallback(
    (uri: string) => {
      openMaybePortForwardedURL(
        uri,
        proxy.preferredWildcardHostname,
        workspaceAgent?.name,
        workspace.data?.name,
        username,
      );
    },
    [workspaceAgent, workspace.data, username, proxy.preferredWildcardHostname],
  );
  const handleWebLinkRef = useRef(handleWebLink);
  useEffect(() => {
    handleWebLinkRef.current = handleWebLink;
  }, [handleWebLink]);

  // Create the terminal!
  const fitAddonRef = useRef<FitAddon>();
  useEffect(() => {
    if (!xtermRef.current || config.isLoading) {
      return;
    }
    const terminal = new XTerm.Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      disableStdin: false,
      fontFamily: MONOSPACE_FONT_FAMILY,
      fontSize: 16,
      theme: {
        background: theme.palette.background.default,
      },
    });
    if (renderer === "webgl") {
      terminal.loadAddon(new WebglAddon());
    } else if (renderer === "canvas") {
      terminal.loadAddon(new CanvasAddon());
    }
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(
      new WebLinksAddon((_, uri) => {
        handleWebLinkRef.current(uri);
      }),
    );

    terminal.open(xtermRef.current);

    // We have to fit twice here. It's unknown why, but the first fit will
    // overflow slightly in some scenarios. Applying a second fit resolves this.
    fitAddon.fit();
    fitAddon.fit();

    // This will trigger a resize event on the terminal.
    const listener = () => fitAddon.fit();
    window.addEventListener("resize", listener);

    // Terminal is correctly sized and is ready to be used.
    setTerminal(terminal);

    return () => {
      window.removeEventListener("resize", listener);
      terminal.dispose();
    };
  }, [theme, renderer, config.isLoading, xtermRef, handleWebLinkRef]);

  // Updates the reconnection token into the URL if necessary.
  useEffect(() => {
    if (searchParams.get("reconnect") === reconnectionToken) {
      return;
    }
    searchParams.set("reconnect", reconnectionToken);
    navigate(
      {
        search: searchParams.toString(),
      },
      {
        replace: true,
      },
    );
  }, [searchParams, navigate, reconnectionToken]);

  // Hook up the terminal through a web socket.
  useEffect(() => {
    if (!terminal) {
      return;
    }

    // The terminal should be cleared on each reconnect
    // because all data is re-rendered from the backend.
    terminal.clear();

    // Focusing on connection allows users to reload the page and start
    // typing immediately.
    terminal.focus();

    // Disable input while we connect.
    terminal.options.disableStdin = true;

    // Show a message if we failed to find the workspace or agent.
    if (workspace.isLoading) {
      return;
    } else if (workspace.error instanceof Error) {
      terminal.writeln(
        Language.workspaceErrorMessagePrefix + workspace.error.message,
      );
      return;
    } else if (!workspaceAgent) {
      terminal.writeln(
        Language.workspaceAgentErrorMessagePrefix +
          "no agent found with ID, is the workspace started?",
      );
      return;
    }

    // Hook up terminal events to the websocket.
    let websocket: WebSocket | null;
    const disposers = [
      terminal.onData((data) => {
        websocket?.send(
          new TextEncoder().encode(JSON.stringify({ data: data })),
        );
      }),
      terminal.onResize((event) => {
        websocket?.send(
          new TextEncoder().encode(
            JSON.stringify({
              height: event.rows,
              width: event.cols,
            }),
          ),
        );
      }),
    ];

    let disposed = false;

    // Open the web socket and hook it up to the terminal.
    terminalWebsocketUrl(
      proxy.preferredPathAppURL,
      reconnectionToken,
      workspaceAgent.id,
      command,
      terminal.rows,
      terminal.cols,
    )
      .then((url) => {
        if (disposed) {
          return; // Unmounted while we waited for the async call.
        }
        websocket = new WebSocket(url);
        websocket.binaryType = "arraybuffer";
        websocket.addEventListener("open", () => {
          // Now that we are connected, allow user input.
          terminal.options = {
            disableStdin: false,
            windowsMode: workspaceAgent?.operating_system === "windows",
          };
          // Send the initial size.
          websocket?.send(
            new TextEncoder().encode(
              JSON.stringify({
                height: terminal.rows,
                width: terminal.cols,
              }),
            ),
          );
          setTerminalState("connected");
        });
        websocket.addEventListener("error", () => {
          terminal.options.disableStdin = true;
          terminal.writeln(
            Language.websocketErrorMessagePrefix + "socket errored",
          );
          setTerminalState("disconnected");
        });
        websocket.addEventListener("close", () => {
          terminal.options.disableStdin = true;
          setTerminalState("disconnected");
        });
        websocket.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            // This exclusively occurs when testing.
            // "jest-websocket-mock" doesn't support ArrayBuffer.
            terminal.write(event.data);
          } else {
            terminal.write(new Uint8Array(event.data));
          }
        });
      })
      .catch((error) => {
        if (disposed) {
          return; // Unmounted while we waited for the async call.
        }
        terminal.writeln(Language.websocketErrorMessagePrefix + error.message);
        setTerminalState("disconnected");
      });

    return () => {
      disposed = true; // Could use AbortController instead?
      disposers.forEach((d) => d.dispose());
      websocket?.close(1000);
    };
  }, [
    command,
    proxy.preferredPathAppURL,
    reconnectionToken,
    terminal,
    workspace.isLoading,
    workspace.error,
    workspaceAgent,
  ]);

  return (
    <ThemeOverride theme={theme}>
      <Helmet>
        <title>
          {workspace.data
            ? pageTitle(
                `Terminal · ${workspace.data.owner_name}/${workspace.data.name}`,
              )
            : ""}
        </title>
      </Helmet>
      <div css={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <TerminalAlerts
          agent={workspaceAgent}
          state={terminalState}
          onAlertChange={() => {
            fitAddonRef.current?.fit();
          }}
        />
        <div css={styles.terminal} ref={xtermRef} data-testid="terminal" />
      </div>

      {latency && isDebugging && (
        <span
          css={{
            position: "absolute",
            bottom: 24,
            right: 24,
            color: theme.palette.text.disabled,
            fontSize: 14,
          }}
        >
          Latency: {latency.latencyMS.toFixed(0)}ms
        </span>
      )}
    </ThemeOverride>
  );
};

type TerminalAlertsProps = {
  agent: WorkspaceAgent | undefined;
  state: TerminalState;
  onAlertChange: () => void;
};

const TerminalAlerts = ({
  agent,
  state,
  onAlertChange,
}: TerminalAlertsProps) => {
  const lifecycleState = agent?.lifecycle_state;
  const prevLifecycleState = useRef(lifecycleState);
  useEffect(() => {
    prevLifecycleState.current = lifecycleState;
  }, [lifecycleState]);

  // We want to observe the children of the wrapper to detect when the alert
  // changes. So the terminal page can resize itself.
  //
  // Would it be possible to just always call fit() when this component
  // re-renders instead of using an observer?
  //
  // This is a good question and the why this does not work is that the .fit()
  // needs to run after the render so in this case, I just think the mutation
  // observer is more reliable. I could use some hacky setTimeout inside of
  // useEffect to do that, I guess, but I don't think it would be any better.
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wrapperRef.current) {
      return;
    }
    const observer = new MutationObserver(onAlertChange);
    observer.observe(wrapperRef.current, { childList: true });

    return () => {
      observer.disconnect();
    };
  }, [onAlertChange]);

  return (
    <div ref={wrapperRef}>
      {state === "disconnected" ? (
        <DisconnectedAlert />
      ) : lifecycleState === "start_error" ? (
        <ErrorScriptAlert />
      ) : lifecycleState === "starting" ? (
        <LoadingScriptsAlert />
      ) : lifecycleState === "ready" &&
        prevLifecycleState.current === "starting" ? (
        <LoadedScriptsAlert />
      ) : null}
    </div>
  );
};

const styles = {
  terminal: (theme) => ({
    width: "100%",
    overflow: "hidden",
    backgroundColor: theme.palette.background.paper,
    flex: 1,
    // These styles attempt to mimic the VS Code scrollbar.
    "& .xterm": {
      padding: 4,
      width: "100%",
      height: "100%",
    },
    "& .xterm-viewport": {
      // This is required to force full-width on the terminal.
      // Otherwise there's a small white bar to the right of the scrollbar.
      width: "auto !important",
    },
    "& .xterm-viewport::-webkit-scrollbar": {
      width: "10px",
    },
    "& .xterm-viewport::-webkit-scrollbar-track": {
      backgroundColor: "inherit",
    },
    "& .xterm-viewport::-webkit-scrollbar-thumb": {
      minHeight: 20,
      backgroundColor: "rgba(255, 255, 255, 0.18)",
    },
  }),
} satisfies Record<string, Interpolation<Theme>>;

export default TerminalPage;
