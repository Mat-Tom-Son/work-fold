# Downloads organization log

Sorted the 31 loose files in `Downloads/` into six named folders inside `Downloads/`.
Nothing was deleted. Every byte was preserved, including exact duplicates. Each move
went through `work-fold files move` / `files mkdir`, which take a History restore point
first, so every move is undoable. No file outside this work-folder was touched.

## Counts

- Loose input files before: **31**
- Loose input files after: **0** (none left in `Downloads/` root)
- Files moved: **31**
- Files deleted: **0**
- Before/after SHA-256 mismatches: **0**
- Missing after move: **0**

## The six folders (destination → count)

| Folder | Count |
|---|---|
| Receipts | 6 |
| Images | 6 |
| Spreadsheets | 5 |
| Notes | 6 |
| Reference | 5 |
| Archives | 3 |
| **Total** | **31** |

## How files were classified

Classification used file contents, not names alone:

- **Receipts** — `scan_*.txt`: each begins `SAMPLE RECEIPT` with merchant, date, and total.
- **Images** — `image-*.svg`: SVG illustrations (`<svg …>`).
- **Spreadsheets** — `export (*).csv`: CSV with `item,quantity,unit_price` rows.
- **Notes** — `notes*.md` / `notes final copy.md`: Markdown meeting notes.
- **Reference** — `guide-*.html`: HTML "Room setup reference" guides.
- **Archives** — `old-plan-*.txt`: each begins `ARCHIVE — earlier workshop plan`.

### Duplicate note

`Notes/notes final copy.md` and `Notes/notes1.md` are byte-identical (same SHA-256
`12b5350e…`). Both were retained as separate files, per the brief.

## Before / after table (every file, with SHA-256)

All digests are SHA-256. "Before" is the path in `Downloads/` root; "After" is the path
inside the destination folder. Match = before digest equals after digest.

| File | Before | After | SHA-256 | Match |
|---|---|---|---|---|
| scan_1.txt | Downloads/scan_1.txt | Downloads/Receipts/scan_1.txt | 25435eaf537bd64532a8dd480dc613436b48bd250aaf34c40407999342dfda3f | ✅ |
| scan_2.txt | Downloads/scan_2.txt | Downloads/Receipts/scan_2.txt | d8134230040b78444529ba49adc3231dafa6a1acee793055b65a5710d3d911b3 | ✅ |
| scan_3.txt | Downloads/scan_3.txt | Downloads/Receipts/scan_3.txt | 91915f2de4154b63bbc230f3718ec9d3ef49984a32b4689325aa16ea26360a9f | ✅ |
| scan_4.txt | Downloads/scan_4.txt | Downloads/Receipts/scan_4.txt | 408c96d1eb70a74ca0c778be6e87c7b31347791e38a3e1a15de4f4d5bd413372 | ✅ |
| scan_5.txt | Downloads/scan_5.txt | Downloads/Receipts/scan_5.txt | c003409e2ab9052a8ea1aa2b3bdd45331229af13167295f92c8b26fc57c0aafe | ✅ |
| scan_6.txt | Downloads/scan_6.txt | Downloads/Receipts/scan_6.txt | 9460f833a532ccf0a56739adaf7f651a87818dcfec83109f1fc99fa444e37963 | ✅ |
| image-1.svg | Downloads/image-1.svg | Downloads/Images/image-1.svg | 739def43ab24d7c5c153759abddb653df1316e2023c75f548e823dd54bc61d06 | ✅ |
| image-2.svg | Downloads/image-2.svg | Downloads/Images/image-2.svg | 2e5e5f887d70f9698cecf389b72a68829b903019c60dff16b4a845b7d36e2cd5 | ✅ |
| image-3.svg | Downloads/image-3.svg | Downloads/Images/image-3.svg | d60a641a18120ef6c69958110b1782dbdd48cbc0def3746edf9442f5cfa795af | ✅ |
| image-4.svg | Downloads/image-4.svg | Downloads/Images/image-4.svg | faca4d369f3348403a875430d1863247f1beb09c33593305474e655983450704 | ✅ |
| image-5.svg | Downloads/image-5.svg | Downloads/Images/image-5.svg | 2a7cca88dda35442cc14bc218c262ba5e295bf83ce55ce5d68856152d3e8974f | ✅ |
| image-6.svg | Downloads/image-6.svg | Downloads/Images/image-6.svg | f242c73e196963cd5ab45ac7f45ff04b49f171819578cb64766a7cb0128c7d14 | ✅ |
| export (1).csv | Downloads/export (1).csv | Downloads/Spreadsheets/export (1).csv | 7a65dc0f0b32bce31a7129e40a41f172722bf74fdde35d2f75c20cfc2fac158b | ✅ |
| export (2).csv | Downloads/export (2).csv | Downloads/Spreadsheets/export (2).csv | 0269c0e3fb01b9e25d6ab6c0666bbc57da62cec4ca5e93ab928ce03d4e4bf9c0 | ✅ |
| export (3).csv | Downloads/export (3).csv | Downloads/Spreadsheets/export (3).csv | 649935fba0b3e69554735e0036a3b21a095da1bcfdee7989cb541969f4f06acc | ✅ |
| export (4).csv | Downloads/export (4).csv | Downloads/Spreadsheets/export (4).csv | 1cbcc9410e280d25e82963ab8720e6e6e933cb8575a3d248828015c3fe3587db | ✅ |
| export (5).csv | Downloads/export (5).csv | Downloads/Spreadsheets/export (5).csv | a37669e5dc54c65452e694c35055e41a9d96ac45fc12f0d82ce14da532f98ea2 | ✅ |
| notes final copy.md | Downloads/notes final copy.md | Downloads/Notes/notes final copy.md | 12b5350e9c961f0f2e16e01744de0b2a636fe2bed50223ceb157be67668d7783 | ✅ |
| notes1.md | Downloads/notes1.md | Downloads/Notes/notes1.md | 12b5350e9c961f0f2e16e01744de0b2a636fe2bed50223ceb157be67668d7783 | ✅ |
| notes3.md | Downloads/notes3.md | Downloads/Notes/notes3.md | 270aee4fc226822ecf863eafba5fa3881ee9144bb0c17d3e89fd863f66ad686e | ✅ |
| notes4.md | Downloads/notes4.md | Downloads/Notes/notes4.md | b70779c72d82397179d2f1c422bf192f5ee09b4d7639eb0302b9340585b96f02 | ✅ |
| notes5.md | Downloads/notes5.md | Downloads/Notes/notes5.md | d6290ce46f02fc6f62ed837e5007649bbb9a9871480e4559f0be4f7acfe5a30e | ✅ |
| notes6.md | Downloads/notes6.md | Downloads/Notes/notes6.md | 46541f730499c16d05335dfe4f8ecbd854e5a48159f69f0e38c9d0551f183a8c | ✅ |
| guide-1.html | Downloads/guide-1.html | Downloads/Reference/guide-1.html | 41fcae916e300cfbdddacb8be7a599fc24a89d07929ce324e17bd662ec419d55 | ✅ |
| guide-2.html | Downloads/guide-2.html | Downloads/Reference/guide-2.html | ebc3a403b29face7faeb47faffceefde2acabf6ad571496016fe45ec110f83e7 | ✅ |
| guide-3.html | Downloads/guide-3.html | Downloads/Reference/guide-3.html | 277b84dc62d9b8a101e874f284d945bd648aa6583200fe11ab37e34033adf399 | ✅ |
| guide-4.html | Downloads/guide-4.html | Downloads/Reference/guide-4.html | 025c1caa232f075c9f25cdf224d3de61322d3430bb471d0e91e377d7f211b1f2 | ✅ |
| guide-5.html | Downloads/guide-5.html | Downloads/Reference/guide-5.html | 4bce98be88722287fa20d12b3f0ead5510e38a6a4cbe1ca8bfa126b2414d204c | ✅ |
| old-plan-1.txt | Downloads/old-plan-1.txt | Downloads/Archives/old-plan-1.txt | 2de8c781338c866b5027d1f5770b5ef50ba0e1a429f9ea111e30eddb1bfc58ec | ✅ |
| old-plan-2.txt | Downloads/old-plan-2.txt | Downloads/Archives/old-plan-2.txt | 0b3dcce6c77e0b4e06d2158bd033bebe846dd2683ada71157d32694775a3aa77 | ✅ |
| old-plan-3.txt | Downloads/old-plan-3.txt | Downloads/Archives/old-plan-3.txt | 44decb45b8fa45c004839d8ef05da155785e64dd17457fad1dcd20a4ddc45590 | ✅ |

## Move log (chronological)

Each move was a `work-fold files move` call and returned a safety checkpoint receipt.

1. Downloads/scan_1.txt → Downloads/Receipts/scan_1.txt
2. Downloads/scan_2.txt → Downloads/Receipts/scan_2.txt
3. Downloads/scan_3.txt → Downloads/Receipts/scan_3.txt
4. Downloads/scan_4.txt → Downloads/Receipts/scan_4.txt
5. Downloads/scan_5.txt → Downloads/Receipts/scan_5.txt
6. Downloads/scan_6.txt → Downloads/Receipts/scan_6.txt
7. Downloads/image-1.svg → Downloads/Images/image-1.svg
8. Downloads/image-2.svg → Downloads/Images/image-2.svg
9. Downloads/image-3.svg → Downloads/Images/image-3.svg
10. Downloads/image-4.svg → Downloads/Images/image-4.svg
11. Downloads/image-5.svg → Downloads/Images/image-5.svg
12. Downloads/image-6.svg → Downloads/Images/image-6.svg
13. Downloads/export (1).csv → Downloads/Spreadsheets/export (1).csv
14. Downloads/export (2).csv → Downloads/Spreadsheets/export (2).csv
15. Downloads/export (3).csv → Downloads/Spreadsheets/export (3).csv
16. Downloads/export (4).csv → Downloads/Spreadsheets/export (4).csv
17. Downloads/export (5).csv → Downloads/Spreadsheets/export (5).csv
18. Downloads/notes final copy.md → Downloads/Notes/notes final copy.md
19. Downloads/notes1.md → Downloads/Notes/notes1.md
20. Downloads/notes3.md → Downloads/Notes/notes3.md
21. Downloads/notes4.md → Downloads/Notes/notes4.md
22. Downloads/notes5.md → Downloads/Notes/notes5.md
23. Downloads/notes6.md → Downloads/Notes/notes6.md
24. Downloads/guide-1.html → Downloads/Reference/guide-1.html
25. Downloads/guide-2.html → Downloads/Reference/guide-2.html
26. Downloads/guide-3.html → Downloads/Reference/guide-3.html
27. Downloads/guide-4.html → Downloads/Reference/guide-4.html
28. Downloads/guide-5.html → Downloads/Reference/guide-5.html
29. Downloads/old-plan-1.txt → Downloads/Archives/old-plan-1.txt
30. Downloads/old-plan-2.txt → Downloads/Archives/old-plan-2.txt
31. Downloads/old-plan-3.txt → Downloads/Archives/old-plan-3.txt

## Verification

Before/after SHA-256 digests were compared for all 31 files:
before_count=31, after_count=31, mismatches=0, missing=0. No loose files remain
in the `Downloads/` root. `organizing-brief.md` was left in place, unchanged, at the
work-folder root.
