# trip-planner

אפליקציית תכנון טיולים סטטית (HTML/CSS/JS, בלי build), מתארחת ב-GitHub Pages. PWA שעובדת אופליין.

## מבנה
- `data/trips.json`: רשימת היעדים (id, name, emoji, startDate, endDate, file).
- `data/<trip>.json`: טיול אחד: `hotels[]` + `days[]`, כל יום עם `blocks[]` (slot: morning/noon/evening) ובהם `items[]`.
- פריט עם `kind: "choice"` מכיל `options[]` (label + items), לחלופות "או זה או זה".
- `app.js`: כל המסכים (ניתוב hash). מקור הנתונים מבודד באובייקט `DataSource`.
- `sw.js`: service worker. data: network-first. קבצי אפליקציה: stale-while-revalidate. אריחי מפה: cache-first.

## כללים לעריכת נתונים
- שדה שאין עליו מידע אמין = `null` (מוצג "לא ידוע"). לא ממציאים שעות, מחירים, טלפונים או כתובות.
- האתר ציבורי: לא לשמור מספרי הזמנה, דרכונים, אימיילים, טלפונים אישיים או כל פרט אישי.
- בכל שינוי בקובץ טיול, לעדכן את `updatedAt` (ISO, UTC).
- `drive` = מרחק וזמן נסיעה מהנקודה הקודמת (מהמלון לנקודה הראשונה). `driveToHotel` על הפריט האחרון ביום.
- `date` ביום אופציונלי: אם חסר, מחושב מ-`startDate` של הטיול + מספר היום.
- `kind`: sight / activity / food / fuel / hike / other.
- מזהי פריטים (`id`) ייחודיים בכל הטיול, באותיות לטיניות ומקפים.

## קוד
- אם משנים את רשימת קבצי האפליקציה ב-`sw.js`, צריך להעלות את `VERSION`.
- בדיקה מקומית: `python3 -m http.server` ואז לפתוח http://localhost:8000.
