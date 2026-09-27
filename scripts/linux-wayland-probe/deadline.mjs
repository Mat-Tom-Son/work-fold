/** Bound fixture waits that have no framework deadline, including CDP discovery. */
export async function withDeadline(label, operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
