"""Train a date-stamp localizer on procedurally rendered package backgrounds."""

from pathlib import Path
import random

import cv2
import numpy as np
import torch
from torch import nn

WIDTH, HEIGHT, STRIDE = 192, 256, 4
SOURCE = Path(__file__).parent
cv2.setNumThreads(0)
torch.set_num_threads(3)
torch.manual_seed(5102)

DOT_FONT = {
    "0": ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
    "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00000", "00100"],
    "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
}


def dots(text, rng):
    pitch = 6
    image = np.zeros((7 * pitch + 8, len(text) * 6 * pitch + 6), np.uint8)
    shear = rng.uniform(-0.3, 0.3)
    for i, char in enumerate(text):
        for row, line in enumerate(DOT_FONT.get(char, [])):
            for col, val in enumerate(line):
                if val == "1" and rng.random() > 0.028:
                    x = int(5 + (i * 6 + col) * pitch + (3 - row) * shear * pitch)
                    cv2.circle(
                        image,
                        (x, 5 + row * pitch),
                        rng.choice([2, 2, 3]),
                        255,
                        -1,
                        cv2.LINE_AA,
                    )
    return image


def stamp(text, rng):
    if rng.random() < 0.66:
        return dots(text, rng)
    face = rng.choice(
        [cv2.FONT_HERSHEY_SIMPLEX, cv2.FONT_HERSHEY_PLAIN, cv2.FONT_HERSHEY_DUPLEX]
    )
    (w, h), base = cv2.getTextSize(text, face, 1.2, 2)
    mask = np.zeros((h + base + 4, w + 4), np.uint8)
    cv2.putText(mask, text, (2, h + 1), face, 1.2, 255, 2, cv2.LINE_AA)
    return mask[: h + 4]


def example(seed):
    rng = random.Random(seed)
    noise = np.random.default_rng(seed)
    image = np.full((HEIGHT, WIDTH), rng.randrange(140, 250), np.uint8)
    for _ in range(rng.randint(2, 9)):
        x, y = rng.randrange(WIDTH), rng.randrange(HEIGHT)
        cv2.rectangle(
            image,
            (x, y),
            (x + rng.randrange(20, WIDTH), y + rng.randrange(10, HEIGHT)),
            rng.randrange(110, 255),
            -1,
        )
    for _ in range(rng.randrange(3, 21)):
        x, y = rng.randrange(WIDTH), rng.randrange(HEIGHT)
        value = rng.choice(
            [
                "Katzenfutter",
                "classic",
                "MINERALS",
                "Energy",
                "61027223",
                "12055397",
                "100 g",
                "01",
                "L 299659",
                "Kcal",
                "CA 34028",
            ]
        )
        cv2.putText(
            image,
            value,
            (x, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            rng.uniform(0.19, 0.7),
            rng.randrange(50, 130),
            1,
            cv2.LINE_AA,
        )
    image = image.astype(np.float32)
    target = None
    if rng.random() > 0.15:
        d, m, y = rng.randrange(1, 29), rng.randrange(1, 13), rng.randrange(24, 37)
        sep = rng.choice(["/", "/", "/", ".", "-"])
        date = f"{d:02}{sep}{m:02}{sep}{y:02}"
        if rng.random() < 0.15:
            date = f"{m:02}{sep}20{y:02}"
        w, h = rng.randint(29, 87), rng.randint(9, 26)
        # Use a range of scales and both sides of the photo.
        x, y = rng.randint(5, WIDTH - w - 5), rng.randint(8, HEIGHT - 2 * h - 9)
        background = rng.uniform(145, 250)
        cv2.rectangle(
            image,
            (max(0, x - 5), y - 6),
            (min(WIDTH - 1, x + w + rng.randrange(8, 66)), y + h + 23),
            background,
            -1,
        )

        def paste(txt, left, top, width, height):
            width = min(width, WIDTH - left)
            if width < 2:
                return
            ink = (
                cv2.resize(
                    stamp(txt, rng), (width, height), interpolation=cv2.INTER_AREA
                )
                / 255
            )
            image[top : top + height, left : left + width] -= ink * rng.uniform(40, 145)

        paste(date, x, y, w, h)
        if rng.random() < 0.85:
            paste(str(rng.randrange(1000000, 99999999)), x + w + 2, y, w, h)
        if rng.random() < 0.7:
            paste(str(rng.randrange(1000000, 99999999)), x, y + h + 3, int(w * 1.4), h)
        target = (x, y, x + w, y + h)
    image += np.linspace(rng.uniform(-22, 22), rng.uniform(-22, 22), WIDTH)[None, :]
    image += noise.normal(0, rng.uniform(0.3, 5), image.shape).astype(np.float32)
    if rng.random() < 0.7:
        image = cv2.GaussianBlur(image, (3, 3), rng.uniform(0.35, 1.02))
    image = np.clip(image, 0, 255).astype(np.uint8)
    return image, target


class Localizer(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 8, 5, 2, 2),
            nn.BatchNorm2d(8),
            nn.ReLU(),
            nn.Conv2d(8, 12, 3, 2, 1),
            nn.BatchNorm2d(12),
            nn.ReLU(),
            nn.Conv2d(12, 20, 5, 1, 2),
            nn.BatchNorm2d(20),
            nn.ReLU(),
            nn.Conv2d(20, 24, 3, 1, 2, dilation=2),
            nn.BatchNorm2d(24),
            nn.ReLU(),
            nn.Conv2d(24, 24, 3, 1, 3, dilation=3),
            nn.BatchNorm2d(24),
            nn.ReLU(),
            nn.Conv2d(24, 5, 1),
        )

    def forward(self, x):
        return self.net(x)


def split(start, n):
    images = np.empty((n, 1, HEIGHT, WIDTH), np.uint8)
    targets = np.zeros((n, 5, HEIGHT // STRIDE, WIDTH // STRIDE), np.float32)
    for i in range(n):
        images[i, 0], box = example(start + i)
        if box is None:
            continue
        x1, y1, x2, y2 = box
        cx, cy = (x1 + x2) / 8, (y1 + y2) / 8
        for y in range(max(0, int(cy) - 1), min(HEIGHT // STRIDE, int(cy) + 2)):
            for x in range(max(0, int(cx) - 1), min(WIDTH // STRIDE, int(cx) + 2)):
                targets[i, :, y, x] = [
                    1,
                    (cx - x) / 2,
                    (cy - y) / 2,
                    (x2 - x1) / WIDTH,
                    (y2 - y1) / HEIGHT,
                ]
    return torch.from_numpy(images), torch.from_numpy(targets)


def loss(out, targets):
    labels = targets[:, 0]
    score = out[:, 0]
    p = torch.sigmoid(score)
    focal = torch.where(labels > 0, (1 - p).square() * 8, p.square())
    cls = (
        nn.functional.binary_cross_entropy_with_logits(score, labels, reduction="none")
        * focal
    ).sum() / labels.sum().clamp_min(1)
    bounds = (
        nn.functional.smooth_l1_loss(out[:, 1:], targets[:, 1:], reduction="none")
        * labels[:, None]
    ).sum() / labels.sum().clamp_min(1)
    return cls + 25 * bounds


def main():
    train_x, train_y = split(20000, 1550)
    val_x, val_y = split(200000, 350)
    net = Localizer()
    opt = torch.optim.AdamW(net.parameters(), lr=0.003)
    for epoch in range(10):
        net.train()
        for batch in torch.randperm(len(train_x)).split(20):
            pred = net(train_x[batch].float() / 127.5 - 1)
            opt.zero_grad()
            loss(pred, train_y[batch]).backward()
            opt.step()
        net.eval()
        with torch.no_grad():
            hit = 0
            positive = 0
            for x, y in zip(val_x.split(25), val_y.split(25)):
                pred = net(x.float() / 127.5 - 1)
                flat = y[:, 0].flatten(1)
                mask = flat.any(dim=1)
                score = pred[:, 0].flatten(1).argmax(dim=1)
                hit += int(flat[torch.arange(len(x)), score][mask].sum())
                positive += int(mask.sum())
            print(
                f"epoch={epoch + 1} synthetic_validation_center_hits={hit}/{positive}",
                flush=True,
            )
        torch.save(net.state_dict(), SOURCE / "localizer.pt")
    torch.onnx.export(
        net,
        torch.zeros(1, 1, HEIGHT, WIDTH),
        SOURCE / "date-localizer.onnx",
        input_names=["image"],
        output_names=["locations"],
        opset_version=17,
        dynamo=False,
    )


if __name__ == "__main__":
    main()
