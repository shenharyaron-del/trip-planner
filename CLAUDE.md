# trip-planner

אפליקציית תכנון טיולים סטטית (HTML/CSS/JS, בלי build), מתארחת ב-GitHub Pages. PWA שעובדת אופליין.

## מבנה
- `data/trips.json`: רשימת היעדים (id, name, emoji, startDate, endDate, file).
- `data/<trip>-links.json`: "קישורים שימושיים" של הטיול: `{updatedAt, links: [{id, title, url, addedAt}]}`. נערך גם מתוך האפליקציה (מצב עריכה), שכותבת ישר ל-`main` דרך GitHub API עם token ששמור במכשיר של העורך. מוגדר ב-trips.json בשדה `linksFile`.
- `data/<trip>.json`: טיול אחד: `hotels[]` + `days[]`, כל יום עם `blocks[]` (slot: morning/noon/evening) ובהם `items[]`.
- פריט עם `kind: "choice"` מכיל `options[]` (label + items), לחלופות "או זה או זה".
- `app.js`: כל המסכים (ניתוב hash). מקור הנתונים מבודד באובייקט `DataSource`.
- `sw.js`: service worker. data: network-first. קבצי אפליקציה: network-first (עם נפילה למטמון אחרי 3 שניות). אריחי מפה: cache-first.

## כללים לעריכת נתונים
- שדה שאין עליו מידע אמין = `null` (מוצג "לא ידוע"). לא ממציאים שעות, מחירים, טלפונים או כתובות.
- האתר ציבורי: לא לשמור מספרי הזמנה, דרכונים, אימיילים, טלפונים אישיים או כל פרט אישי.
- בכל שינוי בקובץ טיול, לעדכן את `updatedAt` (ISO, UTC).
- `drive` = מרחק וזמן נסיעה מהנקודה הקודמת (מהלינה של אתמול לנקודה הראשונה). `driveToHotel` על הפריט האחרון ביום.
  - בלי מפתח `drive` בכלל: אין קטע נהיגה (הליכה, מעבורת, נקודת התחלה). `"drive": null`: יש נהיגה אבל לא ידוע כמה.
  - בחלופות (`choice`) כל האפשרויות צריכות להסתיים באותה נקודה, כדי שה-`drive` של הפריט הבא יהיה נכון.
- לינה: `hotelId` כשיש מלון מוזמן. עד אז `stayArea: {name, lat, lng}` (אזור מתוכנן), ממנו ואליו נבנה המסלול.
- `datesNote` ב-trips.json מוצג כל עוד אין תאריכים. `notes[]` בקובץ הטיול = טיפים כלליים לטיול.
- `slot` יכול להיות גם `day` (כל היום, למשל חלופה של יום שלם).
- `date` ביום אופציונלי: אם חסר, מחושב מ-`startDate` של הטיול + מספר היום.
- `kind`: sight / activity / food / fuel / hike / town / ferry / airport / other.
- מזהי פריטים (`id`) ייחודיים בכל הטיול, באותיות לטיניות ומקפים.

## קוד
- האפליקציה עושה commits ל-`main` (קישורים). לפני כל שינוי: `git pull` (או fetch + rebase), כדי לא לדרוס אותם.
- אם משנים את רשימת קבצי האפליקציה ב-`sw.js`, צריך להעלות את `VERSION`.
- בדיקה מקומית: `python3 -m http.server` ואז לפתוח http://localhost:8000.
