// Character-level diff — computes inline change ranges for paired removed/added lines
// Uses a simple word-boundary diff to highlight exactly what changed within a line

export interface InlineChange {
    /** 0-based column start (inclusive) */
    start: number;
    /** 0-based column end (exclusive) */
    end: number;
}

/**
 * Compute character-level diff between two lines.
 * Returns arrays of changed ranges for each line.
 *
 * Uses word-level tokenization with LCS to find common segments,
 * then marks non-common segments as changes.
 */
export function computeInlineChanges(
    removedLine: string,
    addedLine: string,
): { removedChanges: InlineChange[]; addedChanges: InlineChange[] } {
    // Trivial cases
    if (removedLine === addedLine) return { removedChanges: [], addedChanges: [] };
    if (!removedLine)
        return { removedChanges: [], addedChanges: [{ start: 0, end: addedLine.length }] };
    if (!addedLine)
        return { removedChanges: [{ start: 0, end: removedLine.length }], addedChanges: [] };

    const removedTokens = tokenize(removedLine);
    const addedTokens = tokenize(addedLine);

    const lcs = computeLCS(removedTokens, addedTokens);

    const removedChanges = findChangedRanges(removedLine, removedTokens, lcs.removedMatched);
    const addedChanges = findChangedRanges(addedLine, addedTokens, lcs.addedMatched);

    return { removedChanges, addedChanges };
}

interface Token {
    text: string;
    offset: number;
}

/** Tokenize a line into words and whitespace/punctuation segments */
function tokenize(line: string): Token[] {
    const tokens: Token[] = [];
    const re = /\S+|\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        tokens.push({ text: m[0], offset: m.index });
    }
    return tokens;
}

interface LCSResult {
    removedMatched: boolean[];
    addedMatched: boolean[];
}

/** Standard LCS on token arrays, returns which tokens matched */
function computeLCS(a: Token[], b: Token[]): LCSResult {
    const m = a.length;
    const n = b.length;

    // DP table
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1].text === b[j - 1].text) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find matched tokens
    const removedMatched = new Array(m).fill(false);
    const addedMatched = new Array(n).fill(false);
    let i = m,
        j = n;
    while (i > 0 && j > 0) {
        if (a[i - 1].text === b[j - 1].text) {
            removedMatched[i - 1] = true;
            addedMatched[j - 1] = true;
            i--;
            j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return { removedMatched, addedMatched };
}

/** Convert unmatched tokens into column ranges */
function findChangedRanges(line: string, tokens: Token[], matched: boolean[]): InlineChange[] {
    const changes: InlineChange[] = [];
    let currentStart = -1;

    for (let i = 0; i < tokens.length; i++) {
        if (!matched[i]) {
            if (currentStart === -1) {
                currentStart = tokens[i].offset;
            }
        } else {
            if (currentStart !== -1) {
                const prevToken = tokens[i - 1];
                changes.push({
                    start: currentStart,
                    end: prevToken.offset + prevToken.text.length,
                });
                currentStart = -1;
            }
        }
    }

    // Close trailing range
    if (currentStart !== -1 && tokens.length > 0) {
        const lastToken = tokens[tokens.length - 1];
        changes.push({ start: currentStart, end: lastToken.offset + lastToken.text.length });
    }

    return changes;
}

/**
 * For a hunk with paired removed/added lines, compute inline changes
 * for all paired lines. Unpaired lines (more removed than added or vice versa)
 * are treated as fully changed.
 */
export function computeHunkInlineChanges(
    removedLines: string[],
    addedLines: string[],
): {
    removedLineChanges: InlineChange[][];
    addedLineChanges: InlineChange[][];
} {
    const pairedCount = Math.min(removedLines.length, addedLines.length);
    const removedLineChanges: InlineChange[][] = [];
    const addedLineChanges: InlineChange[][] = [];

    for (let i = 0; i < pairedCount; i++) {
        const { removedChanges, addedChanges } = computeInlineChanges(
            removedLines[i],
            addedLines[i],
        );
        removedLineChanges.push(removedChanges);
        addedLineChanges.push(addedChanges);
    }

    // Unpaired removed lines — fully highlighted
    for (let i = pairedCount; i < removedLines.length; i++) {
        removedLineChanges.push([{ start: 0, end: removedLines[i].length }]);
    }

    // Unpaired added lines — fully highlighted
    for (let i = pairedCount; i < addedLines.length; i++) {
        addedLineChanges.push([{ start: 0, end: addedLines[i].length }]);
    }

    return { removedLineChanges, addedLineChanges };
}
