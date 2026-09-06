# work-fold 0.4.22

Local candidate; not published.

Text Checks give the model clearer field descriptions and an explicit response
format. Invalid responses identify the affected finding and field without
logging or displaying raw model text. Output-limit and interruption failures
have distinct messages. Invalid or partial reviews remain errors, never clear
results, and Checks still cannot edit files or retry a provider automatically.

Existing text Checks require explicit re-enablement because the reviewed
sensor implementation changed. Their declarations and designated files are
preserved. Deterministic Checks and the web bridge are unchanged.

Regression coverage includes optional suggestions, malformed field types,
missing and extra fields, bounded single-paragraph text, partial findings,
truncated submissions, and private diagnostic suppression.
