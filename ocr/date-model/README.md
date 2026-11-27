# Lokale OCR für Datumszeilen

PP-OCRv4-Texterkennung und Textzeilenerkennung aus RapidOCR ONNX Runtime 1.4.4
(Apache-2.0). Die Zeichentabelle stammt aus den Metadaten der ONNX-Datei.
Der Browser führt das Modell mit ONNX Runtime Web 1.22.0 (MIT) aus.

Quellen

- https://pypi.org/project/rapidocr-onnxruntime/1.4.4/
- https://github.com/PaddlePaddle/PaddleOCR
- https://github.com/microsoft/onnxruntime/tree/v1.22.0

## Modell für die Position des Datumsstempels

`date-localizer.onnx` schlägt Bildbereiche vor, wenn die bisherigen
Lesedurchläufe kein MHD finden. PP-OCRv4 liest die vorgeschlagenen Bereiche.
Vacha übernimmt das Datum aus diesem Durchlauf nur, wenn mindestens zwei
Ausschnitte übereinstimmen und kein widersprüchlicher Treffer vorliegt.

Für das Training wurden 1.550 synthetische Verpackungsbilder erzeugt. Ein
separater synthetischer Satz mit 350 Bildern diente zur Validierung. Bei
255 von 294 Bildern mit Stempel lag der höchstbewertete Punkt im
vorgegebenen Bereich um die Stempelmitte. Diese Messung betrifft die
Lokalisierung und misst keine vollständige MHD-Erkennung.

Offline im Browser geprüft wurden das IAMS-Originalfoto, das bearbeitete
Testbild mit geändertem Datum sowie Beispielszenarien mit mehreren und ohne
Datumsangaben. Das Originalfoto und das bearbeitete Bild waren nicht Teil
der Trainingsbilder. Die Auswahl geeigneter Ausschnitte wurde mit ihnen
überprüft und angepasst. Die Beispiele reichen nicht für eine belastbare
Genauigkeitsschätzung bei anderen Verpackungen.

Das reproduzierbare Trainingsskript liegt unter `training/train.py`.
Es benötigt Python, PyTorch, NumPy, OpenCV und ONNX. Der Aufruf
`python ocr/date-model/training/train.py` erzeugt das Modell und einen
Trainings-Checkpoint neben dem Skript.
