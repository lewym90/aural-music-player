# Aural

Premium lokalny odtwarzacz muzyki — PWA do słuchania wysokiej jakości plików z dysku telefonu.

## Funkcje

- Import pojedynczych plików lub całego folderu z muzyką (duplikaty są pomijane)
- Usuwanie utworów z biblioteki
- Lista utworów z wyszukiwaniem (tytuł, wykonawca, album, nazwa pliku)
- Odczyt tagów i okładek (MP3/ID3, M4A, FLAC, OGG) oraz czasu trwania; tagi dla starszych utworów uzupełniają się w tle
- Domyślne sortowanie od najnowszych (według daty pliku), opcjonalnie A–Z
- Pełnoekranowy odtwarzacz (dotknij paska na dole)
- Zapamiętuje ostatni utwór i pozycję — bez automatycznego startu
- Usuwanie: przesuń wiersz w lewo albo „Wybierz” → zaznacz wiele / wszystkie
- Informacja o zajętej pamięci
- Odtwarzanie sekwencyjne lub ręczny wybór
- Wysoka jakość dźwięku (oryginalne pliki, bez transkodowania)
- Brak automatycznego odtwarzania (nic nie włącza się samo po sparowaniu Bluetooth)
- Kontrola przez Media Session API (lock screen, Bluetooth, car audio)
- Możliwość dodania do ekranu startowego iPhone jako pełna aplikacja
- Profesjonalny, przejrzysty interfejs
- Pełna praca offline (po imporcie)

## Instalacja na iPhone

1. Otwórz aplikację w Safari
2. Naciśnij przycisk Udostępnij
3. Wybierz „Dodaj do ekranu początkowego”
4. Potwierdź — Aural pojawi się jako aplikacja

## Uruchomienie lokalne / GitHub Pages

1. Sklonuj repozytorium
2. Serwuj przez dowolny serwer statyczny (np. `npx serve`) — service worker i instalacja wymagają HTTP(S), samo otwarcie `index.html` z dysku nie wystarczy
3. Zaimportuj muzykę

## Uwagi techniczne

- Pliki są kopiowane do IndexedDB urządzenia (zajmują miejsce w pamięci telefonu); dane audio są wczytywane dopiero przy odtwarzaniu
- Aplikacja prosi przeglądarkę o trwały zapis danych; mimo to Safari może wyczyścić dane witryny, jeśli nie używasz jej przez dłuższy czas — po dodaniu do ekranu początkowego ryzyko jest znacznie mniejsze
- Obsługiwane formaty: MP3, M4A, AAC, WAV, FLAC, OGG i inne wspierane przez przeglądarkę
- Wybór całego folderu (`webkitdirectory`) działa w nowszych wersjach iOS; na starszych użyj importu plików
- Audio jest odtwarzane wyłącznie po interakcji użytkownika

## Licencja

MIT

---

Zbudowane z dbałością o jakość dźwięku i doświadczenie użytkownika w samochodzie.
