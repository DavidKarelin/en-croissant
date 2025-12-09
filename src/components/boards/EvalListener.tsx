import { events, type EngineOptions, type GoMode, type BestMoves, type Score } from "@/bindings";
import {
  activeTabAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  enginesAtom,
  tabEngineSettingsFamily,
  liveAnnotationsAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getBestMoves as chessdbGetBestMoves } from "@/utils/chessdb/api";
import { positionFromFen, swapMove } from "@/utils/chessops";
import {
  type Engine,
  type LocalEngine,
  getBestMoves as localGetBestMoves,
  stopEngine,
} from "@/utils/engines";
import { getBestMoves as lichessGetBestMoves } from "@/utils/lichess/api";
import { getAnnotation } from "@/utils/score";
import { useThrottledEffect } from "@/utils/misc";
import { parseUci } from "chessops";
import { makeUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { produce } from "immer";
import { useAtom, useAtomValue } from "jotai";
import { startTransition, useContext, useEffect, useMemo, useCallback, useRef } from "react";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { TreeStateContext } from "../common/TreeStateContext";
import { getNodeAtPath } from "@/utils/treeReducer";

function EvalListener() {
  const [engines] = useAtom(enginesAtom);
  const threat = useAtomValue(currentThreatAtom);
  const store = useContext(TreeStateContext)!;
  const is960 = useStore(store, (s) => s.headers.variant === "Chess960");
  const fen = useStore(store, (s) => s.root.fen);

  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position, is960)),
  );

  const [pos, error] = positionFromFen(fen);
  if (pos) {
    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) {
        console.log("Invalid move", uci);
        break;
      }
      pos.play(move);
    }
  }

  const isGameOver = pos?.isEnd() ?? false;
  const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : null), [pos]);

  const { searchingFen, searchingMoves } = useMemo(
    () =>
      match(threat as boolean)
        .with(true, () => ({
          searchingFen: swapMove(finalFen || INITIAL_FEN),
          searchingMoves: [],
        }))
        .with(false, () => ({
          searchingFen: fen,
          searchingMoves: moves,
        }))
        .exhaustive(),
    [fen, moves, threat, finalFen],
  );

  return engines.map((e) => (
    <EngineListener
      key={e.name}
      engine={e}
      isGameOver={isGameOver}
      finalFen={finalFen || ""}
      searchingFen={searchingFen}
      searchingMoves={searchingMoves}
      fen={fen}
      moves={moves}
      threat={threat}
      chess960={is960}
    />
  ));
}

function EngineListener({
  engine,
  isGameOver,
  finalFen,
  searchingFen,
  searchingMoves,
  fen,
  moves,
  threat,
  chess960,
}: {
  engine: Engine;
  isGameOver: boolean;
  finalFen: string;
  searchingFen: string;
  searchingMoves: string[];
  fen: string;
  moves: string[];
  threat: boolean;
  chess960: boolean;
}) {
  const store = useContext(TreeStateContext)!;
  const setScore = useStore(store, (s) => s.setScore);
  const liveAnnotations = useAtomValue(liveAnnotationsAtom);
  const activeTab = useAtomValue(activeTabAtom);

  const [, setProgress] = useAtom(
    engineProgressFamily({ engine: engine.name, tab: activeTab! }),
  );

  const [, setEngineVariation] = useAtom(
    engineMovesFamily({ engine: engine.name, tab: activeTab! }),
  );

  const engineMoveCache = useAtomValue(
    engineMovesFamily({ engine: engine.name, tab: activeTab! }),
  );
  const [settings] = useAtom(
    tabEngineSettingsFamily({
      engineName: engine.name,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: activeTab!,
    }),
  );
  const pendingNextScores = useRef(new Set<string>());

  const getBestMoves = useMemo(
    () =>
      match(engine.type)
        .with(
          "local",
          () => (fen: string, goMode: GoMode, options: EngineOptions) =>
            localGetBestMoves(engine as LocalEngine, fen, goMode, options),
        )
        .with("chessdb", () => chessdbGetBestMoves)
        .with("lichess", () => lichessGetBestMoves)
        .exhaustive(),
    [engine.type, engine],
  );
  const buildEngineOptions = useMemo(() => {
    const options =
      settings.settings?.map((s) => ({
        name: s.name,
        value: s.value?.toString() || "",
      })) ?? [];
    if (chess960 && !options.find((o) => o.name === "UCI_Chess960")) {
      options.push({ name: "UCI_Chess960", value: "true" });
    }
    return options;
  }, [chess960, settings.settings]);

  const annotateCurrentMove = useCallback(
  async (currentBestMoves: BestMoves[]) => {
    if (
      !liveAnnotations ||
      threat ||
      currentBestMoves.length === 0 ||
      !activeTab ||
      isGameOver
    ) {
      return;
    }

    const state = store.getState();
    const currentPath = state.position;

    // Root has no move to annotate
    if (currentPath.length === 0) return;

    const currentNode = getNodeAtPath(state.root, currentPath);
    if (!currentNode || !currentNode.move) return;

    const parentNode =
      currentPath.length > 0
        ? getNodeAtPath(state.root, currentPath.slice(0, -1))
        : undefined;

    const prevprevNode =
      currentPath.length > 1
        ? getNodeAtPath(state.root, currentPath.slice(0, -2))
        : undefined;

    // "last two moves" scores (already exist on nodes if previously analyzed)
    const prevprevScore = prevprevNode?.score?.value ?? null;
    const prevScore = parentNode?.score?.value ?? null;

    // current move score comes from the live engine payload
    const currentScoreObj = currentBestMoves[0]?.score ?? null;

    // --- KEY FIX #1: Use best-moves from the PARENT position if available ---
    // This is the position where the annotated move was actually chosen.
    const parentMovesList =
      searchingMoves.length > 0 ? searchingMoves.slice(0, -1) : [];

    const parentKey = `${searchingFen}:${parentMovesList.join(",")}`;
    const cachedParent = engineMoveCache.get(parentKey);

    // Fallback to currentBestMoves if we don't have parent multipv yet.
    const annotationPrevMoves =
      cachedParent && cachedParent.length > 0 ? cachedParent : currentBestMoves;

    // Next move info (mainline child) if it exists
    const nextNode = currentNode.children[0];
    const nextMoveUci = nextNode?.move ? makeUci(nextNode.move) : null;

    let nextScore: Score | null = nextNode?.score ?? null;
    let nextKey: string | null = null;

    if (nextMoveUci) {
      const nextMoves = [...searchingMoves, nextMoveUci];
      nextKey = `${searchingFen}:${nextMoves.join(",")}`;

      const cachedNext = engineMoveCache.get(nextKey)?.[0];
      if (!nextScore && cachedNext) {
        nextScore = cachedNext.score;
      }
    }

    // --- KEY FIX #2: compute nextScoreValue AFTER cache fill ---
    const nextScoreValue =
      nextScore?.value ??
      currentScoreObj?.value ??
      currentBestMoves[0].score.value;

    // Helper: ensure only ONE "basic" annotation lives on a node at a time.
    const BASIC = new Set<string>(["!!", "!", "!?", "?!", "?", "??"]);

    const applyBasicAnnotation = (node: any, ann: string) => {
      const existing: string[] = Array.isArray(node.annotations)
        ? node.annotations
        : [];

      const withoutBasic = existing.filter((a) => !BASIC.has(a));

      node.annotations =
        ann && BASIC.has(ann) ? [...withoutBasic, ann] : withoutBasic;
    };

    const isSacrifice =
    (currentNode as any).is_sacrifice ??
    (currentNode as any).isSacrifice ??
    false;

    // 1) Generate an annotation immediately
    // --- KEY FIX #3: pass annotationPrevMoves instead of currentBestMoves ---
    const initialAnnotation = getAnnotation(
    prevprevScore,
    prevScore,
    nextScoreValue,
    currentNode.halfMoves % 2 === 1 ? "white" : "black",
    annotationPrevMoves,
    isSacrifice,
    currentNode.san || "",
  );

    store.setState(
      produce((state) => {
        const node = getNodeAtPath(state.root, currentPath);
        if (!node) return;

        state.dirty = true;

        // Persist the live eval onto the current node as it updates
        if (currentScoreObj) {
          node.score = currentScoreObj;
        }

        applyBasicAnnotation(node, initialAnnotation);
      }),
    );

    // 2) If we don't have a nextScore yet, do a lightweight 1s probe
    if (!nextKey || !nextMoveUci) return;
    if (nextScore) return;
    if (pendingNextScores.current.has(nextKey)) return;

    pendingNextScores.current.add(nextKey);

    try {
      const nextMoves = [...searchingMoves, nextMoveUci];

      const nextEvalOptions = (() => {
        const withoutThreads = buildEngineOptions.filter(
          (o) => o.name !== "Threads",
        );
        return [...withoutThreads, { name: "Threads", value: "1" }];
      })();

      // Use a separate engine process for local next-move probing.
      // This prevents the 1s "next" search from stopping the main live search.
      const probeTab =
        engine.type === "local"
          ? `${activeTab}::live-next-probe::${engine.name}`
          : activeTab;

      const moves = await getBestMoves(
        probeTab,
        { t: "Time", c: 1000 },
        {
          moves: nextMoves,
          fen: searchingFen,
          extraOptions: nextEvalOptions,
        },
      );

      if (!moves) return;

      const [, bestMoves] = moves;
      const best = bestMoves[0];
      if (!best) return;

      nextScore = best.score;

      // Cache the 1s probe result
      setEngineVariation((prev) => {
        const newMap = new Map(prev);
        newMap.set(nextKey!, bestMoves);
        return newMap;
      });

      const updatedAnnotation = getAnnotation(
      prevprevScore,
      prevScore,
      nextScore.value,
      currentNode.halfMoves % 2 === 1 ? "white" : "black",
      annotationPrevMoves,
      isSacrifice,
      currentNode.san || "",
    );

      store.setState(
        produce((state) => {
          const node = getNodeAtPath(state.root, currentPath);
          if (!node) return;

          state.dirty = true;

          if (currentScoreObj) {
            node.score = currentScoreObj;
          }

          applyBasicAnnotation(node, updatedAnnotation);
        }),
      );
    } finally {
      pendingNextScores.current.delete(nextKey);
    }
  },
  [
    activeTab,
    buildEngineOptions,
    engineMoveCache,
    getBestMoves,
    isGameOver,
    liveAnnotations,
    searchingFen,
    JSON.stringify(searchingMoves),
    setEngineVariation,
    store,
    threat,
    engine.name,
    engine.type,
  ],
);
  useEffect(() => {
    if (!settings.enabled) return;
    const unlisten = events.bestMovesPayload.listen(({ payload }) => {
      const ev = payload.bestLines;
      if (
        payload.engine === engine.name &&
        payload.tab === activeTab &&
        payload.fen === searchingFen &&
        equal(payload.moves, searchingMoves) &&
        settings.enabled &&
        !isGameOver
      ) {
        startTransition(() => {
          setEngineVariation((prev) => {
            const newMap = new Map(prev);
            newMap.set(`${searchingFen}:${searchingMoves.join(",")}`, ev);
            if (threat) {
              newMap.delete(`${fen}:${moves.join(",")}`);
            } else if (finalFen) {
              newMap.delete(`${swapMove(finalFen)}:`);
            }
            return newMap;
          });
          setProgress(payload.progress);
          setScore(ev[0].score);
        });
        if (!threat) {
          void annotateCurrentMove(ev);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [
    activeTab,
    setScore,
    settings.enabled,
    isGameOver,
    searchingFen,
    JSON.stringify(searchingMoves),
    engine.name,
    setEngineVariation,
    annotateCurrentMove,
    threat,
    finalFen,
    fen,
    JSON.stringify(moves),
  ]);

  useThrottledEffect(
    () => {
      if (settings.enabled) {
        if (isGameOver) {
          if (engine.type === "local") {
            stopEngine(engine, activeTab!);
          }
        } else {
          getBestMoves(activeTab!, settings.go, {
            moves: searchingMoves,
            fen: searchingFen,
            extraOptions: buildEngineOptions,
          }).then((moves) => {
            if (moves) {
              const [progress, bestMoves] = moves;
              setEngineVariation((prev) => {
                const newMap = new Map(prev);
                newMap.set(
                  `${searchingFen}:${searchingMoves.join(",")}`,
                  bestMoves,
                );
                return newMap;
              });
              setProgress(progress);
            }
          });
        }
      } else {
        if (engine.type === "local") {
          stopEngine(engine, activeTab!);
        }
      }
    },
    50,
    [
      settings.enabled,
      settings.go,
      searchingFen,
      JSON.stringify(searchingMoves),
      isGameOver,
      activeTab,
      getBestMoves,
      setEngineVariation,
      engine,
      buildEngineOptions,
    ],
  );
  return null;
}

export default EvalListener;
