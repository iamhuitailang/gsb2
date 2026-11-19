# -*- coding: utf-8 -*-
"""本地持久化: 解析结果、用户校对修改、入库快照。

按文件内容 SHA-256 归档, 重复解析同一份文件时保留之前的校对记录。
"""
import json
import os
import threading


class Store:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)
        else:
            self.data = {"docs": {}}

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def get(self, h):
        return self.data["docs"].get(h)

    def put(self, h, doc):
        with self._lock:
            self.data["docs"][h] = doc
            self.save()

    def all(self):
        return self.data["docs"]
