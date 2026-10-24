<?php

namespace App\Http\Controllers;

class SmokeController
{
    public function show($id)
    {
        if (!$id) {
            abort(404);
        }

        return response()->json(['id' => $id]);
    }
}
